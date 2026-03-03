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
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

// Segment credentials
const segmentSpaceId = process.env.SEGMENT_SPACE_ID;
const segmentProfileToken = process.env.SEGMENT_PROFILE_TOKEN;

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// In-memory conversation history keyed by Twilio CallSid
const conversationHistory = new Map();

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Send SMS using Twilio Messaging API
async function sendTextMessage(toPhoneNumber, messageBody) {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    
    console.log('\n========== SENDING SMS ==========');
    console.log(`To: ${toPhoneNumber}`);
    console.log(`From: ${twilioPhoneNumber}`);
    console.log(`Message: ${messageBody}`);
    
    const response = await axios.post(url, 
      new URLSearchParams({
        To: toPhoneNumber,
        From: twilioPhoneNumber,
        Body: messageBody
      }), 
      {
        auth: {
          username: accountSid,
          password: authToken
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    console.log('✅ SMS sent successfully');
    console.log('Message SID:', response.data.sid);
    console.log('========== SMS SENT ==========\n');
    
    return {
      success: true,
      messageSid: response.data.sid,
      status: response.data.status
    };
  } catch (error) {
    console.error('\n❌ ERROR SENDING SMS');
    console.error('Error Status:', error.response?.status);
    console.error('Error Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Error Message:', error.message);
    console.error('========== SMS FAILED ==========\n');
    
    return {
      success: false,
      error: error.message
    };
  }
}

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
  const callSid = req.body.CallSid;

  console.log(`Incoming call from: ${callerPhone} (CallSid: ${callSid})`);

  try {
    // Fetch caller profile from Twilio Memory first, then try Segment as fallback
    let profile = await fetchProfileFromMemory(callerPhone);

    // If no profile found in Twilio Memory, try Segment
    if (!profile || !profile.traits) {
      console.log('🔄 No profile from Twilio Memory, trying Segment...');
      profile = await fetchProfileFromSegment(callerPhone);
    }

    // Build system message and let the LLM generate a natural greeting
    const context = loadLLMContext();
    const systemMessage = `${context}\n\nCaller Profile: ${JSON.stringify(profile || 'No profile found')}\n\nCaller Phone: ${callerPhone}`;

    const greetingPrompt = profile && profile.traits
      ? 'The caller just connected. Generate a warm, personalized greeting using their profile information. Then ask how you can help. Keep it to 2-3 sentences for a phone conversation.'
      : 'A new caller just connected and we don\'t have a profile on file for them. Greet them warmly and ask how you can help. Keep it to 1-2 sentences.';

    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: greetingPrompt }
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: messages
    });

    const greetingResponse = completion.choices[0].message.content;
    console.log(`LLM greeting: ${greetingResponse}`);

    // Initialize conversation history for this call
    conversationHistory.set(callSid, {
      systemMessage: systemMessage,
      messages: [
        { role: 'user', content: greetingPrompt },
        { role: 'assistant', content: greetingResponse }
      ],
      profile: profile
    });

    // Speak the LLM-generated greeting and immediately listen for response
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });

    gather.say(greetingResponse);

  } catch (error) {
    console.error('Error in voice handler:', error);
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });
    gather.say('Thank you for calling GrubHub. How can I help you today?');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle user input
app.post('/handle-input', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userInput = req.body.SpeechResult || req.body.Digits;
  const callerPhone = req.body.From;
  const callSid = req.body.CallSid;

  console.log(`User input (CallSid: ${callSid}): ${userInput}`);

  try {
    // Retrieve or initialize conversation history for this call
    let session = conversationHistory.get(callSid);

    if (!session) {
      // Session not found (edge case) — rebuild context
      const context = loadLLMContext();
      let profile = await fetchProfileFromMemory(callerPhone);
      if (!profile || !profile.traits) {
        profile = await fetchProfileFromSegment(callerPhone);
      }
      const systemMessage = `${context}\n\nCaller Profile: ${JSON.stringify(profile || 'No profile found')}\n\nCaller Phone: ${callerPhone}`;
      session = { systemMessage, messages: [], profile };
      conversationHistory.set(callSid, session);
    }

    // Add the caller's latest input to conversation history
    session.messages.push({ role: 'user', content: userInput });

    // Load available tools
    const toolManifest = loadToolManifest();
    const tools = toolManifest.tools || [];

    // Build the full message array: system + conversation history
    const apiMessages = [
      { role: 'system', content: session.systemMessage },
      ...session.messages
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: apiMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined
    });

    let assistantMessage = completion.choices[0].message;

    // Handle tool calls — execute and feed results back to the LLM
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Store the assistant's tool-call message in history
      session.messages.push(assistantMessage);

      // Execute each tool call and collect results
      for (const toolCall of assistantMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`AI requested function: ${functionName}`, functionArgs);

        let toolResult;
        if (functionName === 'send_text_message') {
          const result = await sendTextMessage(callerPhone, functionArgs.message);
          toolResult = result.success
            ? `Text message sent successfully to ${callerPhone}.`
            : `Failed to send text message: ${result.error}`;
        } else {
          toolResult = `Unknown function: ${functionName}`;
        }

        // Add the tool result to conversation history
        session.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }

      // Send the conversation back to the LLM so it can generate a natural response
      const followUp = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          { role: 'system', content: session.systemMessage },
          ...session.messages
        ]
      });

      assistantMessage = followUp.choices[0].message;
    }

    // Store the assistant's final response in history
    const aiResponse = assistantMessage.content;
    session.messages.push({ role: 'assistant', content: aiResponse });

    console.log(`LLM response: ${aiResponse}`);

    // Speak the LLM response and listen for the next input
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });

    gather.say(aiResponse);

  } catch (error) {
    console.error('Error handling input:', error);
    const gather = twiml.gather({
      input: 'speech dtmf',
      action: '/handle-input',
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });
    gather.say('I\'m sorry, I had trouble with that. Could you repeat what you said?');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Status callback handler — clean up conversation history when call ends
app.post('/status-callback', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  console.log(`Call status for ${callSid}: ${callStatus}`);

  if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'canceled' || callStatus === 'no-answer' || callStatus === 'busy') {
    conversationHistory.delete(callSid);
    console.log(`Session cleaned up for CallSid: ${callSid}`);
  }

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
