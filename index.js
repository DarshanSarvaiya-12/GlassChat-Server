require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');

const app = express();
app.use(express.json());

// Store conversations and customer states
const conversations = {};
const customerState = {};

// Health check
app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

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

// RECEIVE ALL MESSAGES
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Handle regular text/image messages
    const message = value?.messages?.[0];

    if (message) {
      const userPhone = message.from;
      const messageType = message.type;

      // BUTTON TAP HANDLER
      if (messageType === 'interactive') {
        const buttonId = message.interactive?.button_reply?.id;
        console.log(`Button tapped: ${buttonId} by ${userPhone}`);

        if (buttonId === 'view_collection') {
          await sendAllProductImages(userPhone);
        } else if (buttonId === 'todays_offers') {
          await sendTextMessage(userPhone,
            "🔥 *Today's Special Offers!*\n\n" +
            "✅ Buy 2 Get 10% OFF\n" +
            "✅ Buy 3 Get 20% OFF\n" +
            "✅ Free delivery above ₹999\n\n" +
            "Collection jova maate niche tap karo! 👇"
          );
          await sendWelcomeButtons(userPhone);
        } else if (buttonId === 'talk_agent') {
          await sendTextMessage(userPhone,
            "👤 *Agent Support*\n\n" +
            "Amaro agent thamari sathe 9AM-6PM " +
            "vachhe connect thase.\n\n" +
            "Abhi collection joi shakho cho! 👇"
          );
          await sendWelcomeButtons(userPhone);
        }
        return res.sendStatus(200);
      }

      // TEXT MESSAGE HANDLER
      if (messageType === 'text') {
        const userText = message.text.body.trim();
        console.log(`Message from ${userPhone}: ${userText}`);

        // NEW CUSTOMER - Send welcome buttons
        if (!customerState[userPhone]) {
          customerState[userPhone] = {
            stage: 'new',
            selectedProducts: [],
            orderDetails: {}
          };
          await sendWelcomeButtons(userPhone);
          return res.sendStatus(200);
        }

        // DETECT PRODUCT CODES
        const detectedCodes = detectProductCodes(userText);

        if (detectedCodes.length > 0 &&
          customerState[userPhone].stage !== 'ordering') {
          // Customer selected products
          customerState[userPhone].stage = 'ordering';
          customerState[userPhone].selectedProducts = detectedCodes;
          await sendOrderSummary(userPhone, detectedCodes);
          return res.sendStatus(200);
        }

        // GEMINI HANDLES EVERYTHING ELSE
        if (!conversations[userPhone]) {
          conversations[userPhone] = [];
        }

        // Build system prompt
        const systemPrompt = `You are a helpful sales assistant for 
${process.env.BUSINESS_NAME} in ${process.env.BUSINESS_CITY}.
You sell t-shirts. Reply in Gujarati and English mixed naturally.
Keep replies short - this is WhatsApp.
Be friendly and help customer complete their purchase.
Current selected products: ${JSON.stringify(customerState[userPhone].selectedProducts)}
Available products: ${JSON.stringify(products)}
Help customer with size selection, quantity, delivery address and close the sale.
Never mention you are AI unless directly asked.`;

        conversations[userPhone].push({
          role: 'user',
          parts: [{ text: userText }]
        });

        const aiReply = await getGeminiReply(
          conversations[userPhone],
          systemPrompt
        );

        conversations[userPhone].push({
          role: 'model',
          parts: [{ text: aiReply }]
        });

        await sendTextMessage(userPhone, aiReply);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
    res.sendStatus(200);
  }
});

// SEND WELCOME BUTTONS
async function sendWelcomeButtons(to) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: `Welcome to ${process.env.BUSINESS_NAME}! 👕\n\nGujarat ni best quality t-shirts\nSurat thi direct factory price! 🔥`
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'view_collection',
                title: '🛍️ View Collection'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'todays_offers',
                title: '💰 Today\'s Offers'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'talk_agent',
                title: '📞 Talk to Agent'
              }
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// SEND ALL PRODUCT IMAGES
async function sendAllProductImages(to) {
  // First send intro text
  await sendTextMessage(to,
    "👕 *Amari T-Shirt Collection*\n\n" +
    "Badhi images juo ane pasand aave te no " +
    "*code* moklo!\n\nExample: *TS01 TS03*"
  );

  // Send each product image with caption
  for (const code in products) {
    const product = products[code];
    await sendImageMessage(to, product.image_url, product.caption);
    // Small delay between images
    await delay(500);
  }

  // Send closing instruction
  await sendTextMessage(to,
    "⬆️ Collection joi lidhu?\n\n" +
    "Hava *product code* moklo!\n" +
    "Example: *TS01* ya *TS01 TS03*\n\n" +
    "Amaro agent thamari order " +
    "complete karvaama madad karse! 😊"
  );
}

// SEND ORDER SUMMARY
async function sendOrderSummary(to, codes) {
  let summary = "🛒 *Tamari Selected Items:*\n\n";
  let total = 0;

  codes.forEach(code => {
    const product = products[code];
    if (product) {
      summary += `✅ ${product.name} (${product.color})\n`;
      summary += `   Code: ${code} | ₹${product.price}\n\n`;
      total += product.price;
    }
  });

  summary += `──────────────────\n`;
  summary += `💰 *Total: ₹${total}*\n`;
  summary += `──────────────────\n\n`;
  summary += `Hu thamne size ane delivery maate help karish!\n\n`;
  summary += `*Konsa size joie che?*\n`;
  summary += `S / M / L / XL / XXL`;

  await sendTextMessage(to, summary);
}

// DETECT PRODUCT CODES IN MESSAGE
function detectProductCodes(text) {
  const upperText = text.toUpperCase();
  const foundCodes = [];

  for (const code in products) {
    if (upperText.includes(code)) {
      foundCodes.push(code);
    }
  }

  return foundCodes;
}

// SEND TEXT MESSAGE
async function sendTextMessage(to, text) {
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

// SEND IMAGE MESSAGE
async function sendImageMessage(to, imageUrl, caption) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// GEMINI AI
async function getGeminiReply(history, systemPrompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: history
      }
    );
    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Gemini error:', error.message);
    return "Sorry, thodi var pachi try karo! 🙏";
  }
}

// DELAY HELPER
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassChat server running on port ${PORT}`);
});