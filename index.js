require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Store conversation history per user
const conversations = {};

// WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// RECEIVE MESSAGES
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    
    if (!message || message.type !== 'text') {
      return res.sendStatus(200);
    }
    
    const userPhone = message.from;
    const userText = message.text.body;
    
    console.log(`Message from ${userPhone}: ${userText}`);
    
    // Get or create conversation history
    if (!conversations[userPhone]) {
      conversations[userPhone] = [];
    }
    
    // Add user message to history
    conversations[userPhone].push({
      role: 'user',
      parts: [{ text: userText }]
    });
    
    // Get AI reply
    const aiReply = await getGeminiReply(conversations[userPhone]);
    
    // Add AI reply to history
    conversations[userPhone].push({
      role: 'model',
      parts: [{ text: aiReply }]
    });
    
    // Send reply to WhatsApp
    await sendWhatsAppMessage(userPhone, aiReply);
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
    res.sendStatus(200);
  }
});

// GEMINI AI
async function getGeminiReply(history) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        system_instruction: {
          parts: [{
            text: `You are a helpful customer care assistant. 
            Be friendly, natural and conversational like a human.
            Keep replies short and clear — this is WhatsApp.
            Never say you are an AI unless directly asked.`
          }]
        },
        contents: history
      }
    );
    
    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Gemini error:', error.message);
    return "Sorry, I'm having trouble responding right now. Please try again!";
  }
}

// SEND WHATSAPP MESSAGE
async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassChat server running on port ${PORT}`);
});
