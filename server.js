require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Twilio credentials
const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const memStoreId = process.env.TWILIO_MEMORY_STORE_ID;

// Segment credentials
const segmentSpaceId = process.env.SEGMENT_SPACE_ID;
const segmentProfileToken = process.env.SEGMENT_PROFILE_TOKEN;

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Fetch profile from Segment
async function fetchProfileFromSegment(phoneNumber) {
  try {
    const url = `https://profiles.segment.com/v1/spaces/${segmentSpaceId}/collections/users/profiles/user_id:${encodeURIComponent(phoneNumber)}/traits?limit=200`;
    
    console.log('\n========== SEGMENT PROFILE LOOKUP START ==========');
    console.log(`Phone Number: ${phoneNumber}`);
    console.log(`SEGMENT API URL: ${url}`);
    console.log(`Space ID: ${segmentSpaceId}`);
    
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(segmentProfileToken + ':').toString('base64')}`
      }
    });
    
    console.log('✅ Segment API Response Status:', response.status);
    console.log('SEGMENT API RAW RESPONSE:', JSON.stringify(response.data, null, 2));
    console.log('========== SEGMENT PROFILE LOOKUP END ==========\n');
    
    // Return traits in the expected format
    const traits = response.data.traits || {};
    if (Object.keys(traits).length > 0) {
      return {
        source: 'segment',
        traits: traits
      };
    }
    
    return null;
  } catch (error) {
    console.error('\n❌ ERROR FETCHING SEGMENT PROFILE');
    console.error('Error Status:', error.response?.status);
    console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Error Message:', error.message);
    console.error('========== SEGMENT PROFILE LOOKUP END ==========\n');
    return null;
  }
}

// Fetch profile from Twilio Memory
async function fetchProfileFromMemory(phoneNumber) {
  try {
    const lookupUrl = `https://memory.twilio.com/v1/Stores/${memStoreId}/Profiles/Lookup`;
    const twilioAuth = {
      username: accountSid,
      password: authToken
    };
    
    console.log('\n========== TWILIO MEMORY PROFILE LOOKUP START ==========');
    console.log(`Phone Number: ${phoneNumber}`);
    console.log(`Lookup URL: ${lookupUrl}`);
    console.log(`Auth User: ${accountSid}`);
    console.log(`Memory Store ID: ${memStoreId}`);
    
    // Step 1: POST to Lookup API with phone number
    const lookupResponse = await axios.post(lookupUrl, {
      idType: "phone",
      value: phoneNumber
    }, { auth: twilioAuth });
    
    console.log('✅ Lookup API Response Status:', lookupResponse.status);
    console.log('Lookup API Response Data:', JSON.stringify(lookupResponse.data, null, 2));
    
    // Step 2: Extract profileId - try both formats
    let profileId = null;
    if (Array.isArray(lookupResponse.data.profiles) && lookupResponse.data.profiles.length > 0) {
      profileId = lookupResponse.data.profiles[0];
      console.log('Found profileId in profiles array:', profileId);
    } else if (lookupResponse.data.id) {
      profileId = lookupResponse.data.id;
      console.log('Found profileId in id field:', profileId);
    } else if (lookupResponse.data.profileId) {
      profileId = lookupResponse.data.profileId;
      console.log('Found profileId in profileId field:', profileId);
    }
    
    // Step 3: Get the full profile with traits using profileId
    if (profileId) {
      const profileUrl = `https://memory.twilio.com/v1/Stores/${memStoreId}/Profiles/${profileId}`;
      
      console.log('\n--- Fetching Full Profile ---');
      console.log(`Profile ID: ${profileId}`);
      console.log(`Profile URL: ${profileUrl}`);
      
      const profileResponse = await axios.get(profileUrl, { auth: twilioAuth });
      
      console.log('✅ Profile API Response Status:', profileResponse.status);
      console.log('Full Profile Data:', JSON.stringify(profileResponse.data, null, 2));
      console.log('========== TWILIO MEMORY PROFILE LOOKUP END ==========\n');
      
      const traits = profileResponse.data.traits || {};
      return {
        source: 'twilio',
        profileId: profileId,
        traits: traits
      };
    }
    
    console.log('⚠️ No profileId found in lookup response');
    console.log('========== TWILIO MEMORY PROFILE LOOKUP END ==========\n');
    return null;
    
  } catch (error) {
    console.error('\n❌ ERROR FETCHING TWILIO MEMORY PROFILE');
    console.error('Error Status:', error.response?.status);
    console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Error Message:', error.message);
    console.error('========== TWILIO MEMORY PROFILE LOOKUP END ==========\n');
    return null;
  }
}

// Load context and manifest files
function loadLLMContext() {
  try {
    const contextPath = path.join(__dirname, process.env.LLM_CONTEXT || 'defaultContext.md');
    if (fs.existsSync(contextPath)) {
      return fs.readFileSync(contextPath, 'utf8');
    }
    return 'You are a helpful AI assistant on a phone call.';
  } catch (error) {
    console.error('Error loading context:', error);
    return 'You are a helpful AI assistant on a phone call.';
  }
}

function loadToolManifest() {
  try {
    const manifestPath = path.join(__dirname, process.env.LLM_MANIFEST || 'defaultToolManifest.json');
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    return [];
  } catch (error) {
    console.error('Error loading manifest:', error);
    return [];
  }
}

// Main voice webhook handler
app.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callerPhone = req.body.From;
  
  console.log(`Incoming call from: ${callerPhone}`);
  
  try {
    // Fetch caller profile from Twilio Memory first, then try Segment as fallback
    let profile = await fetchProfileFromMemory(callerPhone);
    
    // If no profile found in Twilio Memory, try Segment
    if (!profile || !profile.traits) {
      console.log('🔄 No profile from Twilio Memory, trying Segment...');
      profile = await fetchProfileFromSegment(callerPhone);
    }
    
    if (profile && profile.traits) {
      console.log('Profile retrieved successfully');
      
      // Extract traits for personalized greeting
      // Check for nested Contact object (Twilio Memory format) or direct traits (Segment format)
      const contact = profile.traits.Contact || profile.traits;
      const firstName = contact.firstName || contact.firstname || contact.first_name || '';
      const lastName = contact.lastName || contact.lastname || contact.last_name || '';
      const street = contact.street || contact.address || '';
      const city = contact.city || '';
      const state = contact.state || '';
      
      // Build personalized greeting
      let greeting = 'Welcome back';
      if (firstName) {
        greeting += ` ${firstName}`;
        if (lastName) {
          greeting += ` ${lastName}`;
        }
      }
      greeting += '!';
      
      if (street) {
        greeting += ` We have you on record at ${street}`;
        if (city) {
          greeting += ` in ${city}`;
        }
        greeting += '.';
      }
      
      twiml.say({ voice: 'Polly.Joanna' }, greeting);
    } else {
      console.log('No profile found for caller');
      twiml.say({ voice: 'Polly.Joanna' }, 'Welcome! We couldn\'t find your profile.');
    }
    
    // Add menu or next steps
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 3,
      speechTimeout: 'auto'
    });
    
    gather.say({ voice: 'Polly.Joanna' }, 'How can I help you today?');
    
  } catch (error) {
    console.error('Error in voice handler:', error);
    twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, we encountered an error. Please try again.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle user input
app.post('/handle-input', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userInput = req.body.SpeechResult || req.body.Digits;
  const callerPhone = req.body.From;
  
  console.log(`User input: ${userInput}`);
  
  try {
    // Load context and get OpenAI response
    const context = loadLLMContext();
    let profile = await fetchProfileFromMemory(callerPhone);
    
    // If no profile found in Twilio Memory, try Segment as fallback
    if (!profile || !profile.traits) {
      console.log('🔄 No profile from Twilio Memory, trying Segment...');
      profile = await fetchProfileFromSegment(callerPhone);
    }
    
    const systemMessage = `${context}\n\nCaller Profile: ${JSON.stringify(profile || 'No profile found')}`;
    
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userInput }
      ]
    });
    
    const aiResponse = completion.choices[0].message.content;
    
    twiml.say({ voice: 'Polly.Joanna' }, aiResponse);
    
    // Continue conversation
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 3,
      speechTimeout: 'auto'
    });
    
    gather.say({ voice: 'Polly.Joanna' }, 'Is there anything else?');
    
  } catch (error) {
    console.error('Error handling input:', error);
    twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I didn\'t understand that.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Status callback handler
app.post('/status-callback', (req, res) => {
  console.log('Call status:', req.body.CallStatus);
  res.sendStatus(200);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Twilio Voice Server running on port ${PORT}`);
  console.log(`📞 Voice webhook URL: https://${process.env.SERVER_BASE_URL}/voice`);
  console.log(`💾 Memory Store ID: ${memStoreId}`);
});
