require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

connectDB();

app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

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
// MAIN WEBHOOK
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

    // ── BUTTON TAP ──
    if (messageType === 'interactive') {
      const buttonId =
        message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId}`);

      // SIZE BUTTONS
      if (['size_s', 'size_m', 'size_l',
        'size_xl', 'size_xxl'].includes(buttonId)) {
        const sizeMap = {
          size_s: 'S', size_m: 'M', size_l: 'L',
          size_xl: 'XL', size_xxl: 'XXL'
        };
        const selectedSize = sizeMap[buttonId];
        await updateSession(userPhone, {
          'session.selectedSize': selectedSize,
          'session.stage': 'browsing'
        });
        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // PAYMENT BUTTONS
      if (buttonId === 'pay_gpay' ||
        buttonId === 'pay_paytm' ||
        buttonId === 'pay_cod') {

        customer = await Customer.findOne({
          phone: userPhone
        });

        // Block if payment already selected
        if (customer.session.paymentMethod) {
          await sendText(userPhone,
            "⚠️ Payment method already selected.\n\n" +
            "Please complete your current payment."
          );
          return res.sendStatus(200);
        }

        // Block if order already completed
        if (customer.session.stage === 'completed') {
          await sendText(userPhone,
            "✅ Your order is already confirmed.\n\n" +
            "For a new order type: *Send Me Collection*"
          );
          return res.sendStatus(200);
        }

        if (buttonId === 'pay_gpay' ||
          buttonId === 'pay_paytm') {
          const grandTotal =
            customer.session.grandTotal || 0;
          await updateSession(userPhone, {
            'session.paymentMethod': 'online',
            'session.stage': 'payment',
            'session.paymentAmount': grandTotal
          });
          await sendText(userPhone,
            "✅ *Payment Details:*\n\n" +
            "GPay / Paytm Number:\n" +
            `*${process.env.PAYMENT_NUMBER}*\n\n` +
            `Amount: *₹${grandTotal}*\n\n` +
            "Please pay and send screenshot here! 📸"
          );
          return res.sendStatus(200);
        }

        if (buttonId === 'pay_cod') {
          const grandTotal =
            customer.session.grandTotal || 0;
          await updateSession(userPhone, {
            'session.paymentMethod': 'cod',
            'session.stage': 'address',
            'session.paymentStatus': 'cod',
            'session.paymentAmount': grandTotal
          });
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    }

    // ── TEXT MESSAGE ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      customer = await Customer.findOne({
        phone: userPhone
      });

      // Update last message time
      await Customer.findOneAndUpdate(
        { phone: userPhone },
        { $set: { lastMessageAt: new Date() } }
      );

      const lowerText = userText.toLowerCase();
      const stage = customer.session.stage;

      // ── NEW CUSTOMER ──
      if (stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      // ── COLLECTION TRIGGER ──
      // Works from any stage including completed
      if (lowerText === 'send me collection') {
        await resetForNewOrder(userPhone);
        await sendSizeButtons(userPhone);
        return res.sendStatus(200);
      }

      // ── SIZE CHART REQUEST ──
      if (lowerText.includes('size in number') ||
        lowerText.includes('size chart') ||
        lowerText.includes('measurement') ||
        lowerText.includes('inch')) {
        await sendText(userPhone,
          "📏 *Size Chart:*\n\n" +
          "S  = 28 - 30 inches\n\n" +
          "M  = 30 - 32 inches\n\n" +
          "L  = 32 - 34 inches\n\n" +
          "XL = 34 - 36 inches\n\n" +
          "XXL = 36 - 38 inches"
        );
        return res.sendStatus(200);
      }

      // ── COMPLETED STAGE — SUPPORT ONLY ──
      // New order allowed via Send Me Collection
      if (stage === 'completed') {
        await handleGroqAI(
          userPhone, userText, customer, 'support'
        );
        return res.sendStatus(200);
      }

      // ── ADDRESS SUBMISSION ──
      if (stage === 'address') {
        const hasAddressKeywords =
          userText.toUpperCase().includes('NAME') ||
          userText.toUpperCase().includes('HOUSE') ||
          userText.toUpperCase().includes('PINCODE') ||
          userText.length > 50;

        if (hasAddressKeywords) {
          await updateSession(userPhone, {
            'session.deliveryAddress': userText,
            'session.stage': 'confirming'
          });
          await Customer.findOneAndUpdate(
            { phone: userPhone },
            { $set: { fullAddress: userText } }
          );
          await sendText(userPhone, "Okay ✅");
          await delay(800);
          await sendText(userPhone,
            "We will dispatch by *Tomorrow!*\n\n" +
            "You will receive your parcel " +
            "within *5-7 Days* 📦\n\n" +
            "Please send *OKAY* or *DONE* " +
            "to confirm your order."
          );
          setTimeout(async () => {
            const fresh = await Customer.findOne({
              phone: userPhone
            });
            if (fresh?.session?.stage === 'confirming') {
              await sendText(userPhone,
                "⚠️ Please send *OKAY* or *DONE* " +
                "to confirm your order!"
              );
            }
          }, 2 * 60 * 1000);
          return res.sendStatus(200);
        }
      }

      // ── ORDER CONFIRMATION ──
      if (stage === 'confirming') {
        const lower3 = lowerText;
        if (lower3.includes('ok') ||
          lower3.includes('done') ||
          lower3.includes('confirm') ||
          lower3.includes('yes') ||
          lower3.includes('thank')) {

          await updateSession(userPhone, {
            'session.stage': 'completed',
            'session.orderConfirmed': true,
            'session.orderConfirmedAt': new Date()
          });

          customer = await Customer.findOne({
            phone: userPhone
          });

          // Save to order history
          const orderData = {
            orderId: 'ORD-' + Date.now(),
            date: new Date(),
            cart: customer.session.cart,
            purchaseBillSent:
              customer.session.purchaseBillSent,
            orderTotal: customer.session.orderTotal,
            deliveryCharge: customer.session.deliveryCharge,
            grandTotal: customer.session.grandTotal,
            paymentMethod: customer.session.paymentMethod,
            paymentAmount: customer.session.paymentAmount,
            paymentStatus:
              customer.session.paymentMethod === 'cod'
                ? 'cod' : 'paid',
            orderConfirmed: true,
            orderConfirmedAt: new Date(),
            deliveryAddress: customer.session.deliveryAddress,
            parcelShipped: false,
            parcelDelivered: false
          };

          await Customer.findOneAndUpdate(
            { phone: userPhone },
            {
              $push: { orders: orderData },
              $inc: { totalConfirmedOrders: 1 },
              $set: { lastVisit: new Date() }
            }
          );

          await sendText(userPhone,
            "🎉 *Your Order is Confirmed!*"
          );
          await delay(600);

          customer = await Customer.findOne({
            phone: userPhone
          });
          await sendFinalBill(userPhone, customer);
          await delay(600);

          await sendText(userPhone,
            "If you have any questions, " +
            "feel free to ask!\n\n" +
            "*Thank you for Visiting!* 😄"
          );
          return res.sendStatus(200);
        }
      }

      // ── PAYMENT CONFIRMATION BY TEXT ──
      if (stage === 'payment' &&
        customer.session.paymentMethod === 'online') {
        const lower4 = lowerText;
        if (lower4.includes('done') ||
          lower4.includes('paid') ||
          lower4.includes('sent') ||
          lower4.includes('payment') ||
          lower4.includes('screenshot')) {

          customer = await Customer.findOne({
            phone: userPhone
          });
          const grandTotal =
            customer.session.grandTotal || 0;

          await updateSession(userPhone, {
            'session.stage': 'address',
            'session.paymentStatus': 'paid',
            'session.paymentAmount': grandTotal
          });

          await sendText(userPhone,
            `✅ We received your *₹${grandTotal}* payment!\n\n` +
            `Thank you! 🙏`
          );
          await delay(500);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      // ── QUANTITY INPUT ──
      if (stage === 'quantity' &&
        customer.session.pendingCode) {
        const qty = parseInt(userText);
        if (!isNaN(qty) && qty > 0) {
          const code = customer.session.pendingCode;
          const cart = customer.session.cart.map(item => {
            if (item.code === code) {
              item.quantity = qty;
              item.totalPrice = item.pricePerItem * qty;
            }
            return item;
          });

          await updateSession(userPhone, {
            'session.cart': cart,
            'session.pendingCode': null,
            'session.stage': 'browsing'
          });

          await sendText(userPhone,
            "Okay! 👍\n\n" +
            "Would you like to select " +
            "another T-Shirt?\n\n" +
            "Reply *Yes* to select more\n\n" +
            "Reply *No* if you are Done"
          );
          return res.sendStatus(200);
        }
      }

      // ── YES/NO FOR MORE ITEMS ──
      if (stage === 'browsing' &&
        customer.session.cart?.length > 0) {
        const lower2 = lowerText;

        if (lower2 === 'yes' || lower2 === 'y') {
          await sendText(userPhone,
            "Ok I'm waiting! 😊\n\n" +
            "Send the *Code* of the " +
            "T-Shirt you want to add!"
          );
          return res.sendStatus(200);
        }

        if (lower2 === 'no' ||
          lower2 === 'n' ||
          lower2.includes('done') ||
          lower2.includes('these') ||
          lower2.includes('that') ||
          lower2.includes('finalize') ||
          lower2.includes('i want these')) {
          customer = await Customer.findOne({
            phone: userPhone
          });
          await sendPurchaseBill(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // ── ALL OTHER MESSAGES → GROQ AI ──
      await handleGroqAI(
        userPhone, userText, customer, 'sales'
      );
    }

    // ── IMAGE MESSAGE — PAYMENT SCREENSHOT ──
    if (messageType === 'image') {
      customer = await Customer.findOne({
        phone: userPhone
      });

      if (customer?.session?.stage === 'payment' &&
        customer?.session?.paymentMethod === 'online') {

        const grandTotal =
          customer.session.grandTotal || 0;

        await updateSession(userPhone, {
          'session.stage': 'address',
          'session.paymentStatus': 'paid',
          'session.paymentAmount': grandTotal
        });

        await sendText(userPhone,
          `✅ We received your *₹${grandTotal}* payment!\n\n` +
          `Thank you! 🙏`
        );
        await delay(500);
        await sendAddressRequest(userPhone);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────
// GROQ AI HANDLER
// ─────────────────────────────────────

async function handleGroqAI(
  userPhone, userText, customer, mode
) {
  const stage = customer.session.stage;
  const customerContext = buildContext(customer);

  // Build stage awareness message
  let stageInfo = '';

  if (stage === 'new') {
    stageInfo = 'Customer just arrived. Welcome them.';
  } else if (stage === 'browsing') {
    stageInfo =
      `Size buttons were sent. ` +
      `Customer selected size ${customer.session.selectedSize}. ` +
      `Product photos were sent. ` +
      `Waiting for customer to send a product code. ` +
      `Cart has ${customer.session.cart?.length || 0} items.`;
  } else if (stage === 'quantity') {
    stageInfo =
      `Customer selected product ${customer.session.pendingCode}. ` +
      `System confirmed the selection. ` +
      `Waiting for quantity only.`;
  } else if (stage === 'confirmed') {
    stageInfo =
      `Cart is ready. Purchase Bill was sent. ` +
      `Payment buttons were sent. ` +
      `Waiting for customer to select payment method. ` +
      `Do NOT mention payment details — buttons handle it.`;
  } else if (stage === 'payment') {
    stageInfo =
      `Customer selected ${customer.session.paymentMethod} payment. ` +
      `Payment number and amount already sent. ` +
      `Waiting for payment screenshot. ` +
      `Do NOT send payment details again.`;
  } else if (stage === 'address') {
    stageInfo =
      `Payment confirmed. ` +
      `Address format message already sent. ` +
      `Waiting for delivery address only.`;
  } else if (stage === 'confirming') {
    stageInfo =
      `Address received. Dispatch message sent. ` +
      `Waiting for OKAY or DONE from customer only.`;
  } else if (stage === 'completed') {
    stageInfo =
      `Order fully confirmed. Final bill sent. ` +
      `Support mode only. ` +
      `Customer can place new order via Send Me Collection.`;
  }

  const systemPrompt =
`You are Niya, a friendly sales assistant at Ashirwad Shop.
You sell stylish 100% cotton T-Shirts on WhatsApp.

━━━━━━━━━━━━━━
CUSTOMER DATA:
${customerContext}
━━━━━━━━━━━━━━

CURRENT STAGE: ${stage}
WHAT SYSTEM ALREADY DID: ${stageInfo}

━━━━━━━━━━━━━━
YOUR LANGUAGE RULE:
Speak simple English by default.
If customer uses any other language — 
switch to that language immediately
and stay in that language.
━━━━━━━━━━━━━━

YOUR PERSONALITY:
- Warm and helpful like a shopkeeper
- Short replies — maximum 3 lines
- Use emojis naturally
- Never reveal you are an AI
- One question at a time
- Always focused on completing the sale

━━━━━━━━━━━━━━
SHOP INFORMATION:
━━━━━━━━━━━━━━

PRODUCTS: ${JSON.stringify(products)}
FABRIC: 100% Cotton

SIZE CHART:
S=28-30in, M=30-32in, L=32-34in,
XL=34-36in, XXL=36-38in

OFFERS:
- Buy 2 T-Shirts = 10% discount
- Buy 3 or more = 20% discount

SHIPPING:
- Below ₹999 = ₹99 charge
- Above ₹999 = FREE

PAYMENT: GPay / Paytm / Cash on Delivery

RETURN POLICY:
- Return only if product is damaged
- Unboxing video is compulsory for return
- No exchange available
- Nothing is free

━━━━━━━━━━━━━━
PRODUCT CODE RULES — VERY IMPORTANT:
━━━━━━━━━━━━━━

NEVER add product to cart yourself.
Only use ADD_TO_CART tag after customer confirms.

Customer sends code ALONE like "TS01":
→ Treat as confirmation
→ Use tag: ADD_TO_CART:TS01

Customer says "I like TS01" or "TS01 looks nice":
→ Ask: "Want to add TS01 to your order?"
→ Wait for YES before using tag

Customer says "TS01 and TS02" together:
→ Ask: "Add both TS01 and TS02 to order?"
→ Wait for YES before using tag

Customer says "TS01 is costly":
→ Handle price concern
→ Never add to cart
→ Suggest budget option if available

Customer says YES after you asked:
→ Use tag: ADD_TO_CART:[code]
→ For multiple: ADD_TO_CART:TS01,TS02

━━━━━━━━━━━━━━
UNAVAILABLE SIZE RULE:
━━━━━━━━━━━━━━

If customer asks for size not in chart
like 3XL, 4XL, XXS:
→ "Sorry, we only have S to XXL right now.
   Would you like XXL instead?"
Never confirm unavailable sizes.
Never promise future availability.

━━━━━━━━━━━━━━
OFF TOPIC RULES:
━━━━━━━━━━━━━━

Valid business questions (answer briefly):
- Delivery time, return policy, fabric,
  payment options, size chart, offers

Irrelevant questions (refuse politely):
- Politics, jokes, other products,
  anything not related to T-shirt orders
→ "I can only help with T-shirt orders 😊"
→ Then return to current stage immediately

━━━━━━━━━━━━━━
QUESTION DURING ORDER STEPS:
━━━━━━━━━━━━━━

If customer asks valid question mid-order:
1. Answer briefly in 1 line
2. Immediately return to current step
Example:
"Yes we deliver to Mumbai! 🚚
How many TS01 would you like?"

━━━━━━━━━━━━━━
AFTER ORDER CONFIRMED — SUPPORT MODE:
━━━━━━━━━━━━━━

No changes to confirmed order.
No changes after Final Bill.
If customer asks to change order:
"Sorry, order is confirmed.
No changes possible now.
For new order type: Send Me Collection 😊"

Support only:
- Parcel not received → "Arrives in 5-7 days!"
- Damaged product → "Send unboxing video please."
- Complaint → Listen, apologize, guide

━━━━━━━━━━━━━━
TAGS — ADD AT END OF REPLY ONLY:
Customer NEVER sees these tags.
Code reads them and updates database.
━━━━━━━━━━━━━━

ADD_TO_CART:TS01
→ Add single item to cart

ADD_TO_CART:TS01,TS02
→ Add multiple items to cart

REMOVE_ITEM:TS01
→ Remove item from cart

UPDATE_QTY:TS01:3
→ Change quantity of item

━━━━━━━━━━━━━━
STRICT RULES:
━━━━━━━━━━━━━━
- Keep replies short
- maintain gaps between lines properly 
- NEVER add to cart without confirmation
- NEVER make up prices or codes
- NEVER promise free items
- NEVER discuss competitors
- NEVER change confirmed order
- Name and address must be in English
- Stay focused on sales always
- Always know what stage you are in
- Never repeat what system already sent`;

  const recentHistory =
    customer.session.conversationHistory || [];

  recentHistory.push({
    role: 'user',
    parts: [{ text: userText }]
  });

  const aiReply = await getGroqReply(
    recentHistory, systemPrompt
  );

  // ── PARSE ADD_TO_CART TAG ──
  const addMatch = aiReply.match(
    /ADD_TO_CART:([\w,]+)/i
  );
  if (addMatch && stage === 'browsing') {
    const codes = addMatch[1].split(',');
    const existingCart = customer.session.cart || [];

    for (const code of codes) {
      const trimmedCode = code.trim().toUpperCase();
      const product = products[trimmedCode];
      if (product) {
        existingCart.push({
          code: trimmedCode,
          name: product.name,
          color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price,
          quantity: 1,
          totalPrice: product.price
        });
      }
    }

    // If single item added — ask quantity
    if (codes.length === 1) {
      const code = codes[0].trim().toUpperCase();
      await updateSession(userPhone, {
        'session.cart': existingCart,
        'session.stage': 'quantity',
        'session.pendingCode': code
      });

      const product = products[code];
      const cleanReply = aiReply
        .replace(/ADD_TO_CART:[\w,]+/gi, '')
        .trim();

      if (cleanReply.length > 0) {
        await sendText(userPhone, cleanReply);
        await delay(500);
      }

      await sendText(userPhone,
        `✅ *Nice Choice!*\n\n` +
        `Code   : *${code}*\n\n` +
        `Colour : *${product.color}*\n\n` +
        `Price  : *₹${product.price}*\n\n` +
        `How many *${code}* do you want?`
      );
      return;
    }

    // Multiple items — ask quantity for first
    const firstCode = codes[0].trim().toUpperCase();
    await updateSession(userPhone, {
      'session.cart': existingCart,
      'session.stage': 'quantity',
      'session.pendingCode': firstCode
    });

    const cleanReply = aiReply
      .replace(/ADD_TO_CART:[\w,]+/gi, '')
      .trim();
    if (cleanReply.length > 0) {
      await sendText(userPhone, cleanReply);
      await delay(500);
    }
    await sendText(userPhone,
      `How many *${firstCode}* do you want?`
    );
    return;
  }

  // ── PARSE REMOVE_ITEM TAG ──
  const removeMatch = aiReply.match(
    /REMOVE_ITEM:(\w+)/i
  );
  if (removeMatch) {
    const removeCode = removeMatch[1].toUpperCase();
    const updatedCart = customer.session.cart.filter(
      item => item.code !== removeCode
    );
    await updateSession(userPhone, {
      'session.cart': updatedCart
    });
    console.log(`Removed ${removeCode}`);
  }

  // ── PARSE UPDATE_QTY TAG ──
  const updateQtyMatch = aiReply.match(
    /UPDATE_QTY:(\w+):(\d+)/i
  );
  if (updateQtyMatch) {
    const updateCode = updateQtyMatch[1].toUpperCase();
    const newQty = parseInt(updateQtyMatch[2]);
    const updatedCart = customer.session.cart.map(item => {
      if (item.code === updateCode) {
        item.quantity = newQty;
        item.totalPrice = item.pricePerItem * newQty;
      }
      return item;
    });
    await updateSession(userPhone, {
      'session.cart': updatedCart
    });
    console.log(`Updated ${updateCode} qty to ${newQty}`);
  }

  // Clean all tags and send reply
  const cleanReply = aiReply
    .replace(/ADD_TO_CART:[\w,]+/gi, '')
    .replace(/REMOVE_ITEM:\w+/gi, '')
    .replace(/UPDATE_QTY:\w+:\d+/gi, '')
    .trim();

  // Save conversation history
  recentHistory.push({
    role: 'model',
    parts: [{ text: cleanReply }]
  });

  const trimmedHistory = recentHistory.slice(-50);
  await updateSession(userPhone, {
    'session.conversationHistory': trimmedHistory
  });

  if (cleanReply.length > 0) {
    await sendText(userPhone, cleanReply);
  }
}

// ─────────────────────────────────────
// FLOW FUNCTIONS
// ─────────────────────────────────────

async function sendWelcomeMessage(to) {
  await sendText(to,
    "Welcome to *Ashirwad Shop*! 👕\n\n" +
    "Buy Stylish T-Shirts from us!"
  );
  await delay(500);
  await sendSizeButtons(to);
  await updateSession(to, {
    'session.stage': 'browsing'
  });
}

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
          body: { text: "Please select your Size: 👇" },
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

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: "More sizes:" },
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

async function sendAllProductImages(to, size) {
  await sendText(to,
    `Great! You selected Size *${size}* 👍\n\n` +
    `Here is our T-Shirt Collection 👇`
  );
  await delay(300);

  for (const code in products) {
    const product = products[code];
    const caption =
      `Code: ${code}\n` +
      `Colour: ${product.color}\n` +
      `Price: ₹${product.price}`;
    await sendImage(to, product.image_url, caption);
    await delay(600);
  }

  await delay(500);
  await sendText(to,
    "⬆️ Send the *Code* of the T-Shirt " +
    "you want to buy!\n\n" +
    "Example: *TS01*\n\n" +
    "Or send multiple: *TS01 TS03*"
  );
}

function buildBillText(
  cart, orderTotal, discountedTotal,
  discount, shippingCost, grandTotal,
  billType, confirmDateTime
) {
  const title = billType === 'final'
    ? "🧾 *Final Bill:*"
    : "🧾 *Purchase Bill:*";

  let bill = `${title}\n`;
  bill += "─────────────────\n\n";

  cart.forEach((item, index) => {
    bill += `*T-Shirt ${index + 1}:*\n`;
    bill += `Code     : ${item.code}\n`;
    bill += `Size     : ${item.size}\n`;
    bill += `Colour   : ${item.color}\n`;
    bill += `Quantity : ${item.quantity}\n`;
    bill += `Price    : ₹${item.totalPrice || item.pricePerItem}\n`;
    bill += `\n`;
  });

  bill += `─────────────────\n`;
  if (discount > 0) {
    bill += `Original  : ₹${orderTotal}\n`;
    bill += `Discount  : -₹${discount.toFixed(0)}\n`;
  }
  bill += `Total     : ₹${discountedTotal.toFixed(0)}\n`;
  bill += `Shipping  : ${shippingCost === 0 ? 'FREE 🎉' : '₹' + shippingCost}\n`;
  bill += `─────────────────\n`;
  bill += `*Grand Total : ₹${grandTotal.toFixed(0)}*\n`;
  bill += `─────────────────`;

  if (billType === 'final' && confirmDateTime) {
    bill += `\n\n─────────────────\n`;
    bill += `Confirmed :\n${confirmDateTime}\n`;
    bill += `─────────────────`;
  }

  return bill;
}

function calculateTotals(cart) {
  let orderTotal = 0;
  cart.forEach(item => {
    orderTotal += item.totalPrice || item.pricePerItem;
  });
  let discount = 0;
  if (cart.length === 2) discount = orderTotal * 0.10;
  if (cart.length >= 3) discount = orderTotal * 0.20;
  const discountedTotal = orderTotal - discount;
  const shippingCost = discountedTotal >= 999 ? 0 : 99;
  const grandTotal = discountedTotal + shippingCost;
  return {
    orderTotal, discount,
    discountedTotal, shippingCost, grandTotal
  };
}

async function sendPurchaseBill(phone, customer) {
  const cart = customer.session.cart || [];
  if (cart.length === 0) {
    await sendText(phone,
      "No items selected yet.\n\n" +
      "Please select a T-Shirt first!"
    );
    return;
  }

  const {
    orderTotal, discount, discountedTotal,
    shippingCost, grandTotal
  } = calculateTotals(cart);

  await updateSession(phone, {
    'session.orderTotal': discountedTotal,
    'session.deliveryCharge': shippingCost,
    'session.grandTotal': grandTotal,
    'session.stage': 'confirmed',
    'session.purchaseBillSent': true
  });

  const bill = buildBillText(
    cart, orderTotal, discountedTotal,
    discount, shippingCost, grandTotal,
    'purchase', null
  );

  await sendText(phone, bill);
  await delay(800);

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: "How will you make Payment? 💳" },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'pay_gpay', title: '💳 GPay/Paytm' }
              },
              {
                type: 'reply',
                reply: { id: 'pay_cod', title: '💵 Cash on Delivery' }
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

async function sendFinalBill(phone, customer) {
  const cart = customer.session.cart || [];
  if (cart.length === 0) return;

  const {
    orderTotal, discount, discountedTotal,
    shippingCost, grandTotal
  } = calculateTotals(cart);

  const now = new Date();
  const confirmDateTime = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const bill = buildBillText(
    cart, orderTotal, discountedTotal,
    discount, shippingCost, grandTotal,
    'final', confirmDateTime
  );

  await sendText(phone, bill);
}

async function sendAddressRequest(phone) {
  await sendText(phone,
    "📦 Please send your *Shipping Address*\n" +
    "*(in English only)*:\n\n" +
    "NAME -\n\n" +
    "HOUSE NO -\n\n" +
    "ADDRESS -\n\n" +
    "LANDMARK -\n\n" +
    "CITY -\n\n" +
    "PINCODE -\n\n" +
    "DISTRICT -\n\n" +
    "STATE -\n\n" +
    "PHONE NO -"
  );
}

async function resetForNewOrder(phone) {
  await updateSession(phone, {
    'session.stage': 'browsing',
    'session.cart': [],
    'session.selectedSize': null,
    'session.pendingCode': null,
    'session.purchaseBillSent': false,
    'session.orderTotal': 0,
    'session.deliveryCharge': 99,
    'session.grandTotal': 0,
    'session.paymentMethod': null,
    'session.paymentAmount': 0,
    'session.paymentStatus': 'pending',
    'session.orderConfirmed': false,
    'session.orderConfirmedAt': null,
    'session.parcelShipped': false,
    'session.parcelDelivered': false,
    'session.deliveryAddress': null,
    'session.conversationHistory': []
  });
}

// ─────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────

async function getOrCreateCustomer(phone) {
  try {
    let customer = await Customer.findOne({ phone });
    if (!customer) {
      customer = new Customer({
        phone,
        session: { stage: 'new' },
        lastMessageAt: new Date()
      });
      await customer.save();
      console.log(`New customer: ${phone}`);
    } else {
      await Customer.findOneAndUpdate(
        { phone },
        { $inc: { totalVisits: 1 } }
      );
      console.log(`Returning: ${phone}`);
    }
    return customer;
  } catch (error) {
    console.error('Customer error:', error.message);
    return null;
  }
}

function buildContext(customer) {
  let context = '';

  context += customer.totalVisits > 1
    ? `RETURNING CUSTOMER\n`
    : `NEW CUSTOMER\n`;

  context += `Total Visits: ${customer.totalVisits}\n`;
  context += `Total Orders: ${customer.totalConfirmedOrders}\n`;

  if (customer.name) {
    context += `Name: ${customer.name}\n`;
  }
  context += `Phone: ${customer.phone}\n`;
  context += `Language: ${customer.language || 'English'}\n`;

  context += `\nCURRENT STAGE: ${customer.session.stage}\n`;

  if (customer.session.selectedSize) {
    context += `Selected Size: ${customer.session.selectedSize}\n`;
  }

  if (customer.session.cart?.length > 0) {
    context += `\nCART (${customer.session.cart.length} items):\n`;
    customer.session.cart.forEach(item => {
      context += `- ${item.code} | ${item.color} | `;
      context += `Size:${item.size} | `;
      context += `Qty:${item.quantity} | `;
      context += `₹${item.totalPrice}\n`;
    });
    context += `Order Total: ₹${customer.session.orderTotal}\n`;
    context += `Shipping: ₹${customer.session.deliveryCharge}\n`;
    context += `Grand Total: ₹${customer.session.grandTotal}\n`;
    context += `Purchase Bill Sent: ${customer.session.purchaseBillSent}\n`;
    context += `Payment: ${customer.session.paymentMethod || 'not selected'}\n`;
    context += `Payment Status: ${customer.session.paymentStatus}\n`;
  }

  if (customer.session.deliveryAddress) {
    context += `\nAddress: ${customer.session.deliveryAddress}\n`;
  }

  if (customer.orders?.length > 0) {
    context += `\nPAST ORDERS: ${customer.orders.length}\n`;
    const last = customer.orders[customer.orders.length - 1];
    context += `Last: ₹${last.grandTotal} | `;
    context += `${last.paymentMethod} | `;
    context += `Delivered: ${last.parcelDelivered}\n`;
  }

  return context;
}

async function updateSession(phone, data) {
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

async function sendText(to, text) {
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

async function sendImage(to, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption }
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

async function getGroqReply(history, systemPrompt) {
  try {
    const messages = [];
    messages.push({ role: 'system', content: systemPrompt });

    history.forEach(msg => {
      if (!msg || !msg.parts || !msg.parts[0]) return;
      const text = msg.parts[0].text;
      if (!text || text.trim() === '') return;
      messages.push({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: text
      });
    });

    console.log('Groq messages:', messages.length);

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 500,
        temperature: 0.4
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error('Groq error:', error.message);
    if (error.response) {
      console.error('Details:',
        JSON.stringify(error.response.data));
    }
    return "Sorry, please try again in a moment!";
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassChat server running on port ${PORT}`);
});