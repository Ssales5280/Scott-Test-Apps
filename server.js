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

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Fetch profile from Twilio Memory
async function fetchProfileFromMemory(phoneNumber) {
  // Try both 'phone' and 'phoneNumber' as idType since they may be synonymous
  const idTypes = ['phone', 'phoneNumber'];
  
  for (const idType of idTypes) {
    try {
      // Step 1: Lookup profile by phone number
      const lookupUrl = `https://memory.twilio.com/v1/Stores/${memStoreId}/Profiles/Lookup`;
      
      console.log('\n========== PROFILE LOOKUP START ==========');
      console.log(`Phone Number: ${phoneNumber}`);
      console.log(`Lookup URL: ${lookupUrl}`);
      console.log(`Query Params: idType=${idType}, value=${phoneNumber}`);
      console.log(`Auth User: ${accountSid}`);
      console.log(`Memory Store ID: ${memStoreId}`);
      
      const lookupResponse = await axios.get(lookupUrl, {
        params: {
          idType: idType,
          value: phoneNumber
        },
        auth: {
          username: accountSid,
          password: authToken
        }
      });
      
      console.log('✅ Lookup API Response Status:', lookupResponse.status);
      console.log('Lookup API Response Data:', JSON.stringify(lookupResponse.data, null, 2));
      
      // Step 2: Get the full profile with traits using profileId
      if (lookupResponse.data && lookupResponse.data.profileId) {
        const profileId = lookupResponse.data.profileId;
        const profileUrl = `https://memory.twilio.com/v1/Stores/${memStoreId}/Profiles/${profileId}`;
        
        console.log('\n--- Fetching Full Profile ---');
        console.log(`Profile ID: ${profileId}`);
        console.log(`Profile URL: ${profileUrl}`);
        
        const profileResponse = await axios.get(profileUrl, {
          auth: {
            username: accountSid,
            password: authToken
          }
        });
        
        console.log('✅ Profile API Response Status:', profileResponse.status);
        console.log('Full Profile Data:', JSON.stringify(profileResponse.data, null, 2));
        console.log('========== PROFILE LOOKUP END ==========\n');
        return profileResponse.data;
      }
      
      console.log('⚠️ No profileId found in lookup response - returning basic data');
      console.log('========== PROFILE LOOKUP END ==========\n');
      return lookupResponse.data;
      
    } catch (error) {
      // If not found with this idType, try the next one
      if (error.response?.status === 404 && idTypes.indexOf(idType) < idTypes.length - 1) {
        console.log(`⚠️ Profile not found with idType="${idType}", trying next...`);
        continue;
      }
      
      // If it's the last idType or a different error, log and return null
      console.error('\n❌ ERROR FETCHING PROFILE');
      console.error('Error Status:', error.response?.status);
      console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Error Message:', error.message);
      console.error('========== PROFILE LOOKUP END ==========\n');
      return null;
    }
  }
  
  console.log('⚠️ Profile not found with any idType');
  console.log('========== PROFILE LOOKUP END ==========\n');
  return null;
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
    // Fetch caller profile from Twilio Memory
    const profile = await fetchProfileFromMemory(callerPhone);
    
    if (profile && profile.traits) {
      console.log('Profile retrieved successfully');
      
      // Extract traits for personalized greeting
      const firstName = profile.traits.firstName || profile.traits.firstname || '';
      const lastName = profile.traits.lastName || profile.traits.lastname || '';
      const address = profile.traits.address || '';
      
      // Build personalized greeting
      let greeting = 'Welcome back';
      if (firstName) {
        greeting += ` ${firstName}`;
        if (lastName) {
          greeting += ` ${lastName}`;
        }
      }
      greeting += '!';
      
      if (address) {
        greeting += ` We have you on record at ${address}.`;
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
    const profile = await fetchProfileFromMemory(callerPhone);
    
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
