require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

// Connect MongoDB
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

    // Get or create customer
    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    // ── BUTTON TAP HANDLER ──
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

        await updateCustomerSession(userPhone, {
          'session.selectedSize': selectedSize,
          'session.stage': 'browsing'
        });

        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // PAYMENT METHOD BUTTONS
      if (buttonId === 'pay_gpay' ||
        buttonId === 'pay_paytm') {
        await updateCustomerSession(userPhone, {
          'session.paymentMethod': 'online',
          'session.stage': 'payment'
        });
        await sendTextMessage(userPhone,
          "✅ *Payment Details:*\n\n" +
          "GPay / Paytm Number:\n" +
          `*${process.env.PAYMENT_NUMBER || '9999999999'}*\n\n` +
          "Please send the exact amount and\n" +
          "after payment send screenshot here!"
        );
        return res.sendStatus(200);
      }

      if (buttonId === 'pay_cod') {
        await updateCustomerSession(userPhone, {
          'session.paymentMethod': 'cod',
          'session.stage': 'address'
        });
        await sendAddressRequest(userPhone);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ── TEXT MESSAGE HANDLER ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      // Refresh customer
      customer = await Customer.findOne({
        phone: userPhone
      });

      // ── NEW CUSTOMER ──
      if (customer.session.stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      // ── RETURNING CUSTOMER AFTER 10 MINUTES ──
      const tenMinutesAgo = new Date(
        Date.now() - 10 * 60 * 1000
      );
      const isReturning =
        customer.totalVisits > 1 &&
        customer.lastMessageAt &&
        customer.lastMessageAt < tenMinutesAgo &&
        customer.session.stage !== 'new' &&
        customer.session.stage !== 'completed';

      if (isReturning &&
        !customer.session.askedToContinue) {
        await updateCustomerSession(userPhone, {
          'session.askedToContinue': true
        });
        await sendTextMessage(userPhone,
          "👋 *Welcome back!*\n\n" +
          "Do you want to:\n\n" +
          "*1* - Continue previous conversation\n" +
          "*2* - Start new conversation"
        );
        await Customer.findOneAndUpdate(
          { phone: userPhone },
          { $set: { lastMessageAt: new Date() } }
        );
        return res.sendStatus(200);
      }

      // Handle continue/new choice
      if (customer.session.askedToContinue) {
        const lower = userText.toLowerCase();
        if (lower.includes('1') ||
          lower.includes('continue') ||
          lower.includes('previous')) {
          await updateCustomerSession(userPhone, {
            'session.askedToContinue': false
          });
          await sendTextMessage(userPhone,
            "Great! Let's continue where we left off! 😊"
          );
        } else if (lower.includes('2') ||
          lower.includes('new')) {
          await updateCustomerSession(userPhone, {
            'session.stage': 'new',
            'session.cart': [],
            'session.selectedSize': null,
            'session.conversationHistory': [],
            'session.askedToContinue': false,
            'session.deliveryAddress': null,
            'session.orderTotal': 0,
            'session.grandTotal': 0,
            'session.paymentMethod': null,
            'session.pendingCode': null,
            'session.pendingConfirmation': false
          });
          await sendWelcomeMessage(userPhone);
          return res.sendStatus(200);
        }
      }

      // Update last message time
      await Customer.findOneAndUpdate(
        { phone: userPhone },
        { $set: { lastMessageAt: new Date() } }
      );

      const lowerText = userText.toLowerCase();

      // ── SIZE CHART REQUEST ──
      if (lowerText.includes('size in number') ||
        lowerText.includes('size chart') ||
        lowerText.includes('size number') ||
        lowerText.includes('measurement') ||
        lowerText.includes('inch')) {
        await sendTextMessage(userPhone,
          "📏 *Size Chart:*\n" +
          "S  = 28 - 30 inches\n" +
          "M  = 30 - 32 inches\n" +
          "L  = 32 - 34 inches\n" +
          "XL = 34 - 36 inches\n\n" +
          "Select your Size 😊"
        );
        return res.sendStatus(200);
      }

      // ── BILL REQUEST ──
      if (lowerText.includes('bill') ||
        lowerText.includes('order') ||
        lowerText.includes('summary') ||
        lowerText.includes('total')) {
        customer = await Customer.findOne({
          phone: userPhone
        });
        if (customer.session.cart?.length > 0) {
          await sendBillMessage(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // ── DETECT PRODUCT CODE SELECTION ──
      const detectedCodes = detectProductCodes(userText);
      if (detectedCodes.length > 0 &&
        customer.session.stage === 'browsing') {

        const code = detectedCodes[0];
        const product = products[code];

        const existingCart = customer.session.cart || [];
        const newItem = {
          code: code,
          name: product.name,
          color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price,
          quantity: 1,
          totalPrice: product.price
        };
        existingCart.push(newItem);

        await updateCustomerSession(userPhone, {
          'session.cart': existingCart,
          'session.stage': 'quantity',
          'session.pendingCode': code
        });

        await sendTextMessage(userPhone,
          "✅ *Nice Choice!*\n\n" +
          `You Selected:\n\n` +
          `Code   : *${code}*\n\n` +
          `Colour : *${product.color}*\n\n` +
          `Price  : *₹${product.price}*\n\n` +
          `How many *${code}* T-Shirt do you want to buy ?`
        );

        return res.sendStatus(200);
      }

      // ── HANDLE QUANTITY INPUT ──
      if (customer.session.stage === 'quantity' &&
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

          await updateCustomerSession(userPhone, {
            'session.cart': cart,
            'session.pendingCode': null,
            'session.stage': 'browsing'
          });

          await sendTextMessage(userPhone,
            "Okay! 👍\n\n" +
            "Now select the next T-Shirt " +
            "which you want to buy.\n\n" +
            "Reply *Yes* to select more\n\n" +
            "Reply *No* if you are Done"
          );
          return res.sendStatus(200);
        }
      }

      // ── HANDLE YES/NO FOR MORE ITEMS ──
      if (customer.session.stage === 'browsing' &&
        customer.session.cart?.length > 0) {
        const lower2 = userText.toLowerCase();

        if (lower2 === 'yes' || lower2 === 'y') {
          await sendTextMessage(userPhone,
            "Ok I'm waiting! 😊\n\n" +
            "Send the *Code* of the T-Shirt " +
            "you want to add!"
          );
          return res.sendStatus(200);
        }

        if (lower2 === 'no' ||
          lower2 === 'n' ||
          lower2.includes('done') ||
          lower2.includes('these') ||
          lower2.includes('that') ||
          lower2.includes('i want these') ||
          lower2.includes('finalize')) {
          customer = await Customer.findOne({
            phone: userPhone
          });
          await sendFinalBill(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // ── HANDLE ADDRESS SUBMISSION ──
      if (customer.session.stage === 'address') {
        if (userText.toUpperCase().includes('NAME') ||
          userText.toUpperCase().includes('HOUSE') ||
          userText.toUpperCase().includes('PINCODE') ||
          userText.length > 50) {

          await updateCustomerSession(userPhone, {
            'session.deliveryAddress': userText,
            'session.stage': 'confirming'
          });

          await sendTextMessage(userPhone, "Okay ✅");
          await delay(1000);
          await sendTextMessage(userPhone,
            "We will dispatch by *Tomorrow* and you\n" +
            "will receive your parcel within *5-7 Days*! 📦\n\n" +
            "Please send *OKAY* or *DONE* to confirm your order."
          );

          // Remind after 2 minutes if no confirmation
          setTimeout(async () => {
            const freshCustomer = await Customer.findOne(
              { phone: userPhone }
            );
            if (freshCustomer?.session?.stage ===
              'confirming') {
              await sendTextMessage(userPhone,
                "⚠️ Please send *OKAY* or *DONE* " +
                "to confirm your order!"
              );
            }
          }, 2 * 60 * 1000);

          return res.sendStatus(200);
        }
      }

      // ── HANDLE ORDER CONFIRMATION ──
      if (customer.session.stage === 'confirming') {
        const lower3 = userText.toLowerCase();
        if (lower3.includes('ok') ||
          lower3.includes('done') ||
          lower3.includes('confirm') ||
          lower3.includes('yes') ||
          lower3.includes('thank')) {

          await updateCustomerSession(userPhone, {
            'session.stage': 'completed'
          });

          await sendTextMessage(userPhone,
            "🎉 *Your Order is Confirmed!*"
          );
          await delay(500);
          await sendTextMessage(userPhone,
            "*Thank you for Visiting*! 😄\n\n" +
            "We hope to see you again soon! 🛍️"
          );
          return res.sendStatus(200);
        }
      }

      // ── HANDLE PAYMENT CONFIRMATION BY TEXT ──
      if (customer.session.stage === 'payment' &&
        customer.session.paymentMethod === 'online') {
        const lower4 = userText.toLowerCase();
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

          await updateCustomerSession(userPhone, {
            'session.stage': 'address'
          });

          await sendTextMessage(userPhone,
            `✅ Okay! We received your\n` +
            `*₹${grandTotal}* payment!\n\n` +
            `Thank you! 🙏`
          );
          await delay(500);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      // ── GROQ AI HANDLES EVERYTHING ELSE ──
      customer = await Customer.findOne({
        phone: userPhone
      });
      const customerContext =
        buildCustomerContext(customer);

      const systemPrompt =
`You are Niya, a friendly sales assistant at Ashirwad Shop.
You help customers buy stylish cotton T-Shirts on WhatsApp.

━━━━━━━━━━━━━━
CUSTOMER CURRENT STATUS:
${customerContext}
━━━━━━━━━━━━━━

YOUR PERSONALITY:
- Talk like a warm, helpful shopkeeper
- Use simple English only
- Keep replies short — this is WhatsApp, not email
- Use emojis naturally, not excessively
- Never reveal you are an AI
- Ask only ONE question at a time
- Always stay focused on completing the sale
- Be patient — never rush or pressure customer

━━━━━━━━━━━━━
SHOP INFORMATION:
━━━━━━━━━━━━━

PRODUCTS: ${JSON.stringify(products)}

FABRIC: 100% Cotton

SIZE CHART:
S  = 28-30 inches
M  = 30-32 inches
L  = 32-34 inches
XL = 34-36 inches

OFFERS:
- Buy 2 T-Shirts = 10% discount on total
- Buy 3 or more T-Shirts = 20% discount on total

SHIPPING:
- Below ₹999 = ₹99 delivery charge
- Above ₹999 = FREE delivery

PAYMENT:
- GPay or Paytm (online)
- Cash on Delivery (COD)

RETURN POLICY:
- Return only if product is damaged
- Opening parcel video is compulsory for return
- no return and refund without opening parcel video 
- Exchange is not available
- Nothing is free

━━━━━━━━━━━━━
HOW TO HANDLE DIFFERENT SITUATIONS:
━━━━━━━━━━━━━

SITUATION 1 — NEW ORDER:
Customer wants to buy T-Shirts.
Guide them step by step:
1. They select size (size buttons sent automatically)
2. They see collection photos (sent automatically)
3. They send product code like TS01
4. You confirm: "Nice Choice! You selected TS01 Red. How many do you want?"
5. They give quantity
6. Ask if they want more T-Shirts
7. When done, system sends bill automatically
8. Ask payment method
9. After payment, ask for delivery address
10. After address, confirm order

SITUATION 2 — CUSTOMER WANTS TO ADD MORE T-SHIRTS:
If customer says "I want to add one more" or "add TS02 also":
- Say "Sure! Send the code of the T-Shirt you want to add!"
- After they send code, system adds it to cart automatically
- Then ask quantity
- Then show updated bill

SITUATION 3 — CUSTOMER WANTS TO REMOVE A T-SHIRT:
If customer says "remove TS01" or "I don't want TS01":
- Say "Okay, I have removed TS01 from your order."
- Use tag: REMOVE_ITEM:[code] at end of reply
- System will remove it from cart
- Then show updated bill

SITUATION 4 — CUSTOMER WANTS TO CHANGE QUANTITY:
If customer says "change TS01 quantity to 3":
- Say "Sure! Updated TS01 quantity to 3."
- Use tag: UPDATE_QTY:[code]:[new_qty] at end of reply
- System updates cart
- Then show updated bill

SITUATION 5 — CUSTOMER ASKS ABOUT SIZE:
- Share size chart
- Then remind them: "You selected size [their selected size]"
- If they want to change size, note it and update

SITUATION 6 — CUSTOMER ASKS FOR BILL:
- Always send bill in the exact format below
- Never skip or change the bill format

SITUATION 7 — CUSTOMER CONFUSED OR STUCK:
- Gently guide them back to where they were
- Example: "No problem! You were selecting T-Shirts. Want to continue?"

SITUATION 8 — CUSTOMER IS RUDE:
- Stay calm and professional always
- Example: "I understand your concern. Let me help you!"

SITUATION 9 — AFTER ORDER IS CONFIRMED (Support Mode):
- keep short formal replies
- Parcel not received → "Your parcel will arrive in 5-7 days. Please wait!"
- Want to track → "Let me check. Your order is on the way!"
- Damaged product → "I am really sorry! Please send us the opening parcel video for confirmation."
- Any complaint → Listen first, apologize, then guide next step
- Keep replies calm, helpful and short
- close support mode when parcel received

SITUATION 10 — CUSTOMER WANTS NEW ORDER AFTER PREVIOUS OR IN SUPPORT MODE:
- Say "Happy to help with a new order!"
- Guide from size selection again
- Previous order is separate

━━━━━━━━━━━━━
BILL FORMAT — USE THIS EVERY TIME, EXACTLY:
━━━━━━━━━━━━━

🧾 *Your Order Bill:*
─────────────────

*T-Shirt 1:*
Code     : [code]
Size     : [size]
Colour   : [colour]
Quantity : [qty]
Price    : ₹[price]

*T-Shirt 2:*
Code     : [code]
Size     : [size]
Colour   : [colour]
Quantity : [qty]
Price    : ₹[price]

(repeat for all T-Shirts)

─────────────────
Total Price   : ₹[total without shipping]
Shipping Cost : ₹[99 or FREE]
─────────────────
*Grand Total  : ₹[final amount]*
─────────────────

━━━━━━━━━━━━━━━
IMPORTANT TAGS — ADD AT END OF REPLY ONLY:
Customer will NEVER see these tags.
System reads them automatically.
━━━━━━━━━━━━━━━━

REMOVE_ITEM:[code]
→ Use when customer wants to remove a T-Shirt

UPDATE_QTY:[code]:[new_quantity]
→ Use when customer wants to change quantity

SEND_COLLECTION
→ Use when customer asks to see products/photos/collection

Example reply with tag:
"Okay! I have removed TS01 from your cart. Here is your updated bill: [bill]
REMOVE_ITEM:TS01"

━━━━━━━━━━━
STRICT RULES:
━━━━━━━━━━━
- NEVER make up product codes or prices
- NEVER promise free things
- NEVER discuss competitors
- ALWAYS use bill format exactly
- ALWAYS maintain gaps between lines
- For casual replies, use only product CODE not full details
- Full product details only during selection confirmation and in bill
- in support mode End chat gracefully: "If you have any questions, feel free to ask !
*Thank you for Visiting* 😄"`;

      const recentHistory =
        customer.session.conversationHistory || [];

      recentHistory.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      const aiReply = await getGroqReply(
        recentHistory,
        systemPrompt
      );

      // Parse REMOVE_ITEM tag
      const removeMatch = aiReply.match(
        /REMOVE_ITEM:(\w+)/i
      );
      if (removeMatch) {
        const removeCode = removeMatch[1];
        const updatedCart =
          customer.session.cart.filter(
            item => item.code !== removeCode
          );
        await updateCustomerSession(userPhone, {
          'session.cart': updatedCart
        });
        console.log(`Removed ${removeCode} from cart`);
      }

      // Parse UPDATE_QTY tag
      const updateQtyMatch = aiReply.match(
        /UPDATE_QTY:(\w+):(\d+)/i
      );
      if (updateQtyMatch) {
        const updateCode = updateQtyMatch[1];
        const newQty = parseInt(updateQtyMatch[2]);
        const updatedCart = customer.session.cart.map(
          item => {
            if (item.code === updateCode) {
              item.quantity = newQty;
              item.totalPrice = item.pricePerItem * newQty;
            }
            return item;
          }
        );
        await updateCustomerSession(userPhone, {
          'session.cart': updatedCart
        });
        console.log(`Updated ${updateCode} qty to ${newQty}`);
      }

      // Parse SEND_COLLECTION tag
      if (aiReply.includes('SEND_COLLECTION')) {
        const currentSize =
          customer.session.selectedSize || 'M';
        await sendAllProductImages(
          userPhone, currentSize
        );
      }

      // Clean all tags from reply
      const cleanReply = aiReply
        .replace(/REMOVE_ITEM:\w+/gi, '')
        .replace(/UPDATE_QTY:\w+:\d+/gi, '')
        .replace(/SEND_COLLECTION/gi, '')
        .replace(/update\w+:[^\n]*/gi, '')
        .trim();

      recentHistory.push({
        role: 'model',
        parts: [{ text: cleanReply }]
      });

      // Keep last 50 messages = 25 exchanges
      const trimmedHistory = recentHistory.slice(-50);

      await updateCustomerSession(userPhone, {
        'session.conversationHistory': trimmedHistory
      });

      await sendTextMessage(userPhone, cleanReply);
    }

    // ── IMAGE MESSAGE HANDLER ──
    if (messageType === 'image') {
      const customer2 = await Customer.findOne({
        phone: userPhone
      });

      if (customer2?.session?.stage === 'payment' &&
        customer2?.session?.paymentMethod === 'online') {

        const grandTotal =
          customer2.session.grandTotal || 0;

        await updateCustomerSession(userPhone, {
          'session.stage': 'address'
        });

        await sendTextMessage(userPhone,
          `✅ Okay! We received your\n` +
          `*₹${grandTotal}* payment!\n\n` +
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
// FLOW FUNCTIONS
// ─────────────────────────────────────

// SEND WELCOME MESSAGE + SIZE BUTTONS
async function sendWelcomeMessage(to) {
  await sendTextMessage(to,
    "Welcome to *Ashirwad Shop*! 👕\n\n" +
    "Buy Stylish T-Shirts from us!"
  );

  await delay(500);

  try {
    // First 3 size buttons
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "Please select your Size: 👇"
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

    // XL and XXL buttons
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "More sizes:"
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

    await updateCustomerSession(to, {
      'session.stage': 'browsing'
    });

  } catch (error) {
    console.error('Welcome button error:', error.message);
  }
}

// SEND ALL PRODUCT IMAGES
async function sendAllProductImages(to, size) {
  await sendTextMessage(to,
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
    await sendImageMessage(to, product.image_url, caption);
    await delay(600);
  }

  await delay(500);
  await sendTextMessage(to,
    "⬆️ Send the *Code* of the T-Shirt\n" +
    "which you want to buy!\n\n" +
    "Example: *TS01*"
  );
}

// BUILD BILL TEXT — used everywhere consistently
function buildBillText(cart, orderTotal,
  discountedTotal, discount, shippingCost, grandTotal) {

  let bill = "🧾 *Your Order Bill:*\n";
  bill += "─────────────────\n\n";

  cart.forEach((item, index) => {
    bill += `*T-Shirt ${index + 1}:*\n`;
    bill += `Code     : ${item.code}\n`;
    bill += `Size     : ${item.size}\n`;
    bill += `Colour   : ${item.color}\n`;
    bill += `Quantity : ${item.quantity}\n`;
    bill += `Price    : ₹${item.totalPrice ||
      item.pricePerItem}\n`;
    bill += `\n`;
  });

  bill += `─────────────────\n`;

  if (discount > 0) {
    bill += `Original Price : ₹${orderTotal}\n`;
    bill += `Discount       : -₹${discount.toFixed(0)}\n`;
  }

  bill += `Total Price   : ₹${discountedTotal.toFixed(0)}\n`;
  bill += `Shipping Cost : ${shippingCost === 0
    ? 'FREE 🎉'
    : '₹' + shippingCost}\n`;
  bill += `─────────────────\n`;
  bill += `*Grand Total  : ₹${grandTotal.toFixed(0)}*\n`;
  bill += `─────────────────`;

  return bill;
}

// SEND BILL MESSAGE — called anytime bill needed
async function sendBillMessage(phone, customer) {
  const cart = customer.session.cart || [];
  if (cart.length === 0) return;

  let orderTotal = 0;
  cart.forEach(item => {
    orderTotal += item.totalPrice || item.pricePerItem;
  });

  let discount = 0;
  if (cart.length === 2) discount = orderTotal * 0.10;
  if (cart.length >= 3) discount = orderTotal * 0.20;
  const discountedTotal = orderTotal - discount;

  const shippingCost =
    customer.session.deliveryCharge !== undefined
      ? customer.session.deliveryCharge
      : discountedTotal >= 999 ? 0 : 99;

  const grandTotal = discountedTotal + shippingCost;

  const bill = buildBillText(
    cart, orderTotal, discountedTotal,
    discount, shippingCost, grandTotal
  );

  await sendTextMessage(phone, bill);
}

// SEND FINAL BILL + PAYMENT BUTTONS
async function sendFinalBill(phone, customer) {
  const cart = customer.session.cart || [];

  if (cart.length === 0) {
    await sendTextMessage(phone,
      "No items in cart. Please select a T-Shirt first!"
    );
    return;
  }

  // Calculate totals
  let orderTotal = 0;
  cart.forEach(item => {
    orderTotal += item.totalPrice || item.pricePerItem;
  });

  let discount = 0;
  if (cart.length === 2) discount = orderTotal * 0.10;
  if (cart.length >= 3) discount = orderTotal * 0.20;
  const discountedTotal = orderTotal - discount;

  let shippingCost = discountedTotal >= 999 ? 0 : 99;
  const grandTotal = discountedTotal + shippingCost;

  // Save totals to DB
  await updateCustomerSession(phone, {
    'session.orderTotal': discountedTotal,
    'session.deliveryCharge': shippingCost,
    'session.grandTotal': grandTotal,
    'session.stage': 'confirmed'
  });

  // Build and send bill
  const bill = buildBillText(
    cart, orderTotal, discountedTotal,
    discount, shippingCost, grandTotal
  );

  await sendTextMessage(phone, bill);
  await delay(800);

  // Send payment method buttons
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
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
                  title: '💳 GPay/Paytm'
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

// SEND ADDRESS REQUEST
async function sendAddressRequest(phone) {
  await sendTextMessage(phone,
    "📦 Please send your *Shipping Address* in this format:\n\n" +
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

// ─────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────

// GET OR CREATE CUSTOMER
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

// BUILD CUSTOMER CONTEXT FOR AI
function buildCustomerContext(customer) {
  let context = '';

  if (customer.totalVisits > 1) {
    context += `RETURNING CUSTOMER\n`;
    context += `Total Visits: ${customer.totalVisits}\n`;
  } else {
    context += `NEW CUSTOMER\n`;
  }

  if (customer.name) {
    context += `Name: ${customer.name}\n`;
  }

  context += `Phone: ${customer.phone}\n`;
  context += `Stage: ${customer.session.stage}\n`;

  if (customer.session.selectedSize) {
    context += `Selected Size: ${customer.session.selectedSize}\n`;
  }

  if (customer.session.cart?.length > 0) {
    context += `\nCURRENT CART `;
    context += `(${customer.session.cart.length} items):\n`;
    customer.session.cart.forEach(item => {
      context += `- ${item.code}: ${item.name} `;
      context += `${item.color} `;
      context += `Size:${item.size} `;
      context += `Qty:${item.quantity} `;
      context += `₹${item.totalPrice}\n`;
    });
    context +=
      `Order Total: ₹${customer.session.orderTotal}\n`;
    context +=
      `Grand Total: ₹${customer.session.grandTotal}\n`;
  }

  if (customer.session.deliveryAddress) {
    context += `\nDelivery Address:\n`;
    context += `${customer.session.deliveryAddress}\n`;
  }

  if (customer.orders?.length > 0) {
    context += `\nPREVIOUS ORDERS: `;
    context += `${customer.orders.length} past orders\n`;
  }

  return context;
}

// UPDATE CUSTOMER SESSION
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

// UPDATE CUSTOMER STAGE
async function updateCustomerStage(phone, stage) {
  await updateCustomerSession(phone, {
    'session.stage': stage
  });
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

// GROQ AI
async function getGroqReply(history, systemPrompt) {
  try {
    const messages = [];

    messages.push({
      role: 'system',
      content: systemPrompt
    });

    history.forEach(msg => {
      if (!msg || !msg.parts || !msg.parts[0]) return;
      const text = msg.parts[0].text;
      if (!text || text.trim() === '') return;
      messages.push({
        role: msg.role === 'model'
          ? 'assistant'
          : 'user',
        content: text
      });
    });

    console.log('Sending to Groq:',
      messages.length, 'messages');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
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
      console.error('Groq details:',
        JSON.stringify(error.response.data));
    }
    return "Sorry, please try again in a moment!";
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