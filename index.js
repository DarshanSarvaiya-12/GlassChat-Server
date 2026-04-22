require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const {
  connectDB,
  Customer,
  Settings,
  getSettings
} = require('./db');

const app = express();
app.use(express.json());

connectDB();

// Health check
app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

// WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' &&
    token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────
// SETTINGS API
// ─────────────────────────────────────

app.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/business', async (req, res) => {
  try {
    const { businessName, businessCity } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { businessName, businessCity } },
      { new: true, upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/prompt', async (req, res) => {
  try {
    const { systemPrompt } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { systemPrompt } },
      { new: true, upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/shipping', async (req, res) => {
  try {
    const {
      freeShipping,
      freeShippingAbove,
      shippingCharge
    } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      {
        $set: {
          freeShipping,
          freeShippingAbove,
          shippingCharge
        }
      },
      { new: true, upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/offers/add', async (req, res) => {
  try {
    const { title, description } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      {
        $push: {
          offers: { title, description, active: true }
        }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/offers/update', async (req, res) => {
  try {
    const { offerId, title, description, active } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main', 'offers._id': offerId },
      {
        $set: {
          'offers.$.title': title,
          'offers.$.description': description,
          'offers.$.active': active
        }
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/offers/delete', async (req, res) => {
  try {
    const { offerId } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $pull: { offers: { _id: offerId } } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────
// WHATSAPP WEBHOOK
// ─────────────────────────────────────

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const userPhone = message.from;
    const messageType = message.type;

    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    const settings = await getSettings();

    // ── BUTTON TAP HANDLER ──
    if (messageType === 'interactive') {
      const buttonId =
        message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId} from ${userPhone}`);

      // SIZE BUTTONS
      if (['size_s','size_m','size_l',
           'size_xl','size_xxl'].includes(buttonId)) {
        const sizeMap = {
          size_s: 'S', size_m: 'M', size_l: 'L',
          size_xl: 'XL', size_xxl: 'XXL'
        };
        const selectedSize = sizeMap[buttonId];

        await updateCustomerSession(userPhone, {
          'session.stage': 'browsing',
          'session.selectedSize': selectedSize,
          'session.cart': []
        });

        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // PAYMENT METHOD BUTTONS
      if (buttonId === 'pay_gpay') {
        await updateCustomerSession(userPhone, {
          'session.stage': 'awaiting_payment',
          'session.paymentMethod': 'gpay'
        });
        customer = await Customer.findOne({
          phone: userPhone
        });
        const grandTotal =
          customer.session.grandTotal;
        await sendTextMessage(userPhone,
          `💳 *GPay / Paytm Payment*\n\n` +
          `Please send ₹*${grandTotal}* to:\n\n` +
          `📱 *9998887776*\n\n` +
          `After payment please send the ` +
          `*screenshot* here! 📸`
        );
        return res.sendStatus(200);
      }

      if (buttonId === 'pay_cod') {
        await updateCustomerSession(userPhone, {
          'session.stage': 'cod_address',
          'session.paymentMethod': 'cod',
          'session.deliveryCharge': 99
        });
        await sendAddressFormat(userPhone);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ── TEXT MESSAGE HANDLER ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone} [${customer.session.stage}]: ${userText}`);

      const stage = customer.session.stage;

      // ── NEW CUSTOMER ──
      if (stage === 'new') {
        await sendWelcomeAndSizeButtons(
          userPhone, settings
        );
        await updateCustomerSession(userPhone, {
          'session.stage': 'welcomed'
        });
        return res.sendStatus(200);
      }

      // ── WELCOMED - WAITING FOR SIZE ──
      if (stage === 'welcomed') {
        await sendSizeButtons(userPhone);
        return res.sendStatus(200);
      }

      // ── BROWSING - DETECT PRODUCT CODE ──
      if (stage === 'browsing') {
        // Check size in numbers request
        if (isSizeNumberRequest(userText)) {
          await sendTextMessage(userPhone,
            "📏 *Size Guide:*\n\n" +
            "S  = 28 - 30\n" +
            "M  = 30 - 32\n" +
            "L  = 32 - 34\n" +
            "XL = 34 - 36\n\n" +
            "Please send the product code " +
            "you want to order! 😊"
          );
          return res.sendStatus(200);
        }

        const detectedCodes =
          detectProductCodes(userText);

        if (detectedCodes.length > 0) {
          const code = detectedCodes[0];
          const product = products[code];
          const size = customer.session.selectedSize;

          // Save current item
          await updateCustomerSession(userPhone, {
            'session.stage': 'item_selecting',
            'session.currentItem': {
              code,
              name: product.name,
              color: product.color,
              size,
              pricePerItem: product.price
            }
          });

          await sendTextMessage(userPhone,
            `✅ *Nice choice!*\n\n` +
            `You selected:\n` +
            `Code: *${code}*\n` +
            `Colour: *${product.color}*\n` +
            `Size: *${size}*\n` +
            `Price: *₹${product.price}*\n\n` +
            `How many *${code}* do you want to buy?`
          );
          return res.sendStatus(200);
        }

        await sendTextMessage(userPhone,
          "Please send a valid product code.\n" +
          "Example: *TS01* or *TS02*"
        );
        return res.sendStatus(200);
      }

      // ── ITEM SELECTING - GET QUANTITY ──
      if (stage === 'item_selecting') {
        const qty = parseInt(userText);
        if (isNaN(qty) || qty < 1) {
          await sendTextMessage(userPhone,
            "Please send a valid number.\n" +
            "Example: 1 or 2 or 3"
          );
          return res.sendStatus(200);
        }

        const currentItem = customer.session.currentItem;
        const totalPrice =
          currentItem.pricePerItem * qty;
        const newItem = {
          ...currentItem,
          quantity: qty,
          totalPrice
        };

        // Add to cart
        const existingCart =
          customer.session.cart || [];
        existingCart.push(newItem);

        // Calculate totals
        const orderTotal = existingCart.reduce(
          (sum, i) => sum + i.totalPrice, 0
        );
        const settings = await getSettings();
        let deliveryCharge = settings.shippingCharge;
        if (settings.freeShipping) {
          deliveryCharge = 0;
        } else if (
          orderTotal >= settings.freeShippingAbove
        ) {
          deliveryCharge = 0;
        }
        const grandTotal = orderTotal + deliveryCharge;

        await updateCustomerSession(userPhone, {
          'session.cart': existingCart,
          'session.currentItem': null,
          'session.orderTotal': orderTotal,
          'session.deliveryCharge': deliveryCharge,
          'session.grandTotal': grandTotal,
          'session.stage': 'awaiting_more'
        });

        await sendTextMessage(userPhone,
          `Okay! Now do you want to select ` +
          `another T-Shirt?\n\n` +
          `Reply *Yes* to select more\n` +
          `Reply *No* if you are done`
        );
        return res.sendStatus(200);
      }

      // ── AWAITING MORE ITEMS ──
      if (stage === 'awaiting_more') {
        const lower = userText.toLowerCase();

        if (lower === 'yes' || lower === 'y') {
          await updateCustomerSession(userPhone, {
            'session.stage': 'browsing'
          });
          await sendTextMessage(userPhone,
            "Ok I'm waiting! 😊\n\n" +
            "Send me the code of the next " +
            "T-Shirt you want!"
          );
          return res.sendStatus(200);
        }

        if (lower === 'no' || lower === 'n') {
          // Customer done selecting
          customer = await Customer.findOne({
            phone: userPhone
          });
          await sendTextMessage(userPhone,
            "Okay No Problem! 👍"
          );
          await delay(500);
          await sendBill(userPhone, customer);
          await delay(500);
          await sendPaymentMethodButtons(userPhone);
          await updateCustomerSession(userPhone, {
            'session.stage': 'payment_method'
          });
          return res.sendStatus(200);
        }

        // Check if it's I want these / done
        if (isDoneSelecting(userText)) {
          customer = await Customer.findOne({
            phone: userPhone
          });
          await sendTextMessage(userPhone,
            "Okay Get it! 🎉"
          );
          await delay(500);
          await sendBill(userPhone, customer);
          await delay(500);
          await sendPaymentMethodButtons(userPhone);
          await updateCustomerSession(userPhone, {
            'session.stage': 'payment_method'
          });
          return res.sendStatus(200);
        }

        await sendTextMessage(userPhone,
          "Please reply *Yes* or *No*"
        );
        return res.sendStatus(200);
      }

      // ── AWAITING PAYMENT SCREENSHOT ──
      if (stage === 'awaiting_payment') {
        // Any message after payment instruction
        // treat as payment confirmation
        customer = await Customer.findOne({
          phone: userPhone
        });
        await updateCustomerSession(userPhone, {
          'session.stage': 'online_address'
        });
        await sendTextMessage(userPhone,
          `✅ Okay! We received your ` +
          `*₹${customer.session.grandTotal}* payment.`
        );
        await delay(500);
        await sendAddressFormat(userPhone);
        return res.sendStatus(200);
      }

      // ── COD / ONLINE ADDRESS ──
      if (stage === 'cod_address' ||
          stage === 'online_address') {
        // Check if address has all required fields
        const addressValid = isAddressValid(userText);

        if (!addressValid) {
          await sendTextMessage(userPhone,
            "⚠️ Please fill all details properly " +
            "in the given format.\n\n" +
            "Some fields are missing!"
          );
          await sendAddressFormat(userPhone);
          return res.sendStatus(200);
        }

        await updateCustomerSession(userPhone, {
          'session.deliveryAddress': userText,
          'session.stage': 'awaiting_confirmation'
        });

        await sendTextMessage(userPhone, "Okay ✅");
        await delay(1000);
        await sendTextMessage(userPhone,
          "We will dispatch by Tomorrow and you " +
          "will receive your Parcel within *5-7 Days*. 📦"
        );

        // Wait 2 minutes for confirmation
        setTimeout(async () => {
          const c = await Customer.findOne({
            phone: userPhone
          });
          if (c && c.session.stage ===
              'awaiting_confirmation') {
            await sendTextMessage(userPhone,
              "Please send *OKAY* or *DONE* " +
              "to confirm your order ✅"
            );
          }
        }, 2 * 60 * 1000);

        return res.sendStatus(200);
      }

      // ── AWAITING CONFIRMATION ──
      if (stage === 'awaiting_confirmation') {
        if (isConfirmation(userText)) {
          await updateCustomerSession(userPhone, {
            'session.stage': 'completed'
          });
          await sendTextMessage(userPhone,
            "Your Order is Confirmed! 🎉"
          );
          await delay(500);
          await sendTextMessage(userPhone,
            "Thank you for Visiting! 😄"
          );
          return res.sendStatus(200);
        }

        await sendTextMessage(userPhone,
          "Please send *OKAY* or *DONE* " +
          "to confirm your order ✅"
        );
        return res.sendStatus(200);
      }

      // ── COMPLETED ──
      if (stage === 'completed') {
        await sendTextMessage(userPhone,
          "Your order has already been confirmed! 🎉\n\n" +
          "Thank you for shopping with us! 😄"
        );
        return res.sendStatus(200);
      }
    }

    // IMAGE MESSAGE - treat as payment screenshot
    if (messageType === 'image') {
      const stage = customer.session.stage;
      if (stage === 'awaiting_payment') {
        customer = await Customer.findOne({
          phone: userPhone
        });
        await updateCustomerSession(userPhone, {
          'session.stage': 'online_address'
        });
        await sendTextMessage(userPhone,
          `✅ Okay! We received your ` +
          `*₹${customer.session.grandTotal}* payment.`
        );
        await delay(500);
        await sendAddressFormat(userPhone);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────

async function getOrCreateCustomer(phone) {
  try {
    let customer = await Customer.findOne({ phone });
    if (!customer) {
      customer = new Customer({
        phone,
        session: { stage: 'new' }
      });
      await customer.save();
      console.log(`New customer: ${phone}`);
    } else {
      await Customer.findOneAndUpdate(
        { phone },
        {
          $inc: { totalVisits: 1 },
          $set: { lastVisit: new Date() }
        }
      );
    }
    return customer;
  } catch (error) {
    console.error('Customer error:', error.message);
    return null;
  }
}

async function updateCustomerSession(phone, data) {
  try {
    await Customer.findOneAndUpdate(
      { phone },
      { $set: data },
      { new: true }
    );
  } catch (error) {
    console.error('Update error:', error.message);
  }
}

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

function isSizeNumberRequest(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'size in number', 'size number',
    'number size', 'show size',
    'size chart', 'what size',
    'size measurement', 'measurement'
  ];
  return keywords.some(k => lower.includes(k));
}

function isDoneSelecting(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'i want these', 'done', 'that\'s all',
    'thats all', 'finish', 'completed',
    'i am done', 'i\'m done', 'place order',
    'order these', 'confirm', 'these only',
    'bas', 'enough'
  ];
  return keywords.some(k => lower.includes(k));
}

function isAddressValid(text) {
  const required = [
    'NAME', 'HOUSE', 'ADDRESS',
    'CITY', 'PINCODE', 'STATE', 'PHONE'
  ];
  const upper = text.toUpperCase();
  return required.every(field => upper.includes(field));
}

function isConfirmation(text) {
  const lower = text.toLowerCase().trim();
  const keywords = [
    'okay', 'ok', 'done', 'yes',
    'confirm', 'confirmed', 'sure',
    'thank you', 'thanks', 'great',
    'perfect', 'good', 'alright'
  ];
  return keywords.some(k => lower.includes(k));
}

// SEND WELCOME + SIZE BUTTONS
async function sendWelcomeAndSizeButtons(to, settings) {
  await sendTextMessage(to,
    `Welcome to *${settings.businessName}*! 👕\n\n` +
    `Buy Stylish T-Shirts from us! 🛍️`
  );
  await delay(500);
  await sendSizeButtons(to);
}

// SEND SIZE BUTTONS
async function sendSizeButtons(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "Please select your Size 👇"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'size_s', title: 'S' }
              },
              {
                type: 'reply',
                reply: { id: 'size_m', title: 'M' }
              },
              {
                type: 'reply',
                reply: { id: 'size_l', title: 'L' }
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
    await delay(500);
    // Send XL and XXL as second button message
    // because WhatsApp only allows 3 buttons max
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "Or select larger size 👇"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'size_xl', title: 'XL' }
              },
              {
                type: 'reply',
                reply: { id: 'size_xxl', title: 'XXL' }
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
  } catch (error) {
    console.error('Size button error:', error.message);
  }
}

// SEND PAYMENT METHOD BUTTONS
async function sendPaymentMethodButtons(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "How will you make Payment? 💳"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'pay_gpay',
                  title: '💳 GPay / Paytm'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'pay_cod',
                  title: '💵 Cash on Delivery'
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
  } catch (error) {
    console.error('Payment button error:', error.message);
  }
}

// SEND ALL PRODUCT IMAGES
async function sendAllProductImages(to, size) {
  await sendTextMessage(to,
    `👕 *Our T-Shirt Collection*\n\n` +
    `Size selected: *${size}*\n\n` +
    `Check all images below!`
  );

  for (const code in products) {
    const product = products[code];
    const caption =
      `Code: ${code}\n` +
      `Colour: ${product.color}\n` +
      `Price: ₹${product.price}`;
    await sendImageMessage(
      to,
      product.image_url,
      caption
    );
    await delay(600);
  }

  await sendTextMessage(to,
    "Send the *Code* of T-Shirt " +
    "which you want to buy! 👆\n\n" +
    "Example: *TS01*"
  );
}

// SEND BILL
async function sendBill(to, customer) {
  const cart = customer.session.cart;
  let bill = "🧾 *Your Bill*\n";
  bill += "─────────────────\n\n";

  cart.forEach((item, index) => {
    bill += `*${index + 1}. ${item.name}*\n`;
    bill += `Code     : ${item.code}\n`;
    bill += `Size     : ${item.size}\n`;
    bill += `Colour   : ${item.color}\n`;
    bill += `Qty      : ${item.quantity}\n`;
    bill += `Price    : ₹${item.totalPrice}\n\n`;
  });

  bill += `─────────────────\n`;
  bill += `Total Price    : ₹${customer.session.orderTotal}\n`;
  bill += `Shipping Cost  : ₹${customer.session.deliveryCharge}\n`;
  bill += `*Grand Total   : ₹${customer.session.grandTotal}*\n`;
  bill += `─────────────────`;

  await sendTextMessage(to, bill);
}

// SEND ADDRESS FORMAT
async function sendAddressFormat(to) {
  await sendTextMessage(to,
    "Please send your Shipping Address " +
    "in this format:\n\n" +
    "NAME -\n" +
    "HOUSE NO -\n" +
    "ADDRESS -\n" +
    "LANDMARK -\n" +
    "CITY -\n" +
    "PINCODE -\n" +
    "DISTRICT -\n" +
    "STATE -\n" +
    "PHONE NO -"
  );
}

// SEND TEXT MESSAGE
async function sendTextMessage(to, text) {
  try {
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
  } catch (error) {
    console.error('Send error:', error.message);
  }
}

// SEND IMAGE MESSAGE
async function sendImageMessage(to, imageUrl, caption) {
  try {
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
  } catch (error) {
    console.error('Image error:', error.message);
  }
}

// DELAY HELPER
function delay(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `GlassChat server running on port ${PORT}`
  );
});