const mongoose = require('mongoose');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected!');
  } catch (error) {
    console.error('MongoDB error:', error.message);
  }
};

// ─────────────────────────────────────
// CUSTOMER SCHEMA
// ─────────────────────────────────────

const customerSchema = new mongoose.Schema({

  // ── IDENTITY ──
  phone: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    default: null
  },
  language: {
    type: String,
    default: 'English'
  },
  fullAddress: {
    type: String,
    default: null
  },

  // ── VISIT TRACKING ──
  firstVisit: {
    type: Date,
    default: Date.now
  },
  lastVisit: {
    type: Date,
    default: Date.now
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  totalVisits: {
    type: Number,
    default: 1
  },

  // ── ORDER STATS ──
  totalConfirmedOrders: {
    type: Number,
    default: 0
  },

  // ── CURRENT SESSION ──
  // Live data updated during chat
  session: {

    stage: {
      type: String,
      enum: [
        'new',
        'browsing',
        'confirmed',
        'sizing',
        'quantity',
        'address',
        'payment',
        'confirming',
        'completed'
      ],
      default: 'new'
    },

    // Selected items in current order
    cart: [{
      code: String,
      name: String,
      color: String,
      size: {
        type: String,
        default: null
      },
      quantity: {
        type: Number,
        default: 1
      },
      pricePerItem: Number,
      totalPrice: {
        type: Number,
        default: 0
      }
    }],

    selectedSize: {
      type: String,
      default: null
    },

    pendingCode: {
      type: String,
      default: null
    },

    // Billing
    purchaseBillSent: {
      type: Boolean,
      default: false
    },
    orderTotal: {
      type: Number,
      default: 0
    },
    deliveryCharge: {
      type: Number,
      default: 99
    },
    grandTotal: {
      type: Number,
      default: 0
    },

    // Payment
    paymentMethod: {
      type: String,
      enum: ['online', 'cod', null],
      default: null
    },
    paymentAmount: {
      type: Number,
      default: 0
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cod'],
      default: 'pending'
    },

    // Order
    orderConfirmed: {
      type: Boolean,
      default: false
    },
    orderConfirmedAt: {
      type: Date,
      default: null
    },

    // Delivery
    parcelShipped: {
      type: Boolean,
      default: false
    },
    parcelShippedAt: {
      type: Date,
      default: null
    },
    parcelDelivered: {
      type: Boolean,
      default: false
    },
    parcelDeliveredAt: {
      type: Date,
      default: null
    },

    // Delivery address for this order
    deliveryAddress: {
      type: String,
      default: null
    },

    // Conversation state
    askedToContinue: {
      type: Boolean,
      default: false
    },
    pendingConfirmation: {
      type: Boolean,
      default: false
    },

    // Last 25 exchanges = 50 messages
    conversationHistory: {
      type: Array,
      default: []
    },

    // Session expires after 7 days
    expiresAt: {
      type: Date,
      default: () => new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
      index: { expires: 0 }
    }
  },

  // ── ORDER HISTORY ──
  // All past confirmed orders saved here
  orders: [{
    orderId: {
      type: String,
      default: () => 'ORD-' + Date.now()
    },
    date: {
      type: Date,
      default: Date.now
    },

    // Items ordered
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: Number,
      pricePerItem: Number,
      totalPrice: Number
    }],

    // Billing
    purchaseBillSent: {
      type: Boolean,
      default: false
    },
    orderTotal: Number,
    deliveryCharge: Number,
    grandTotal: Number,

    // Payment
    paymentMethod: {
      type: String,
      enum: ['online', 'cod']
    },
    paymentAmount: {
      type: Number,
      default: 0
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cod'],
      default: 'pending'
    },

    // Order
    orderConfirmed: {
      type: Boolean,
      default: false
    },
    orderConfirmedAt: {
      type: Date,
      default: null
    },

    // Delivery address
    deliveryAddress: String,

    // Parcel status
    parcelShipped: {
      type: Boolean,
      default: false
    },
    parcelShippedAt: {
      type: Date,
      default: null
    },
    parcelDelivered: {
      type: Boolean,
      default: false
    },
    parcelDeliveredAt: {
      type: Date,
      default: null
    }
  }]

});

const Customer = mongoose.model(
  'Customer',
  customerSchema
);

// ─────────────────────────────────────
// SETTINGS SCHEMA
// ─────────────────────────────────────

const settingsSchema = new mongoose.Schema({

  singleton: {
    type: String,
    default: 'main',
    unique: true
  },
  businessName: {
    type: String,
    default: 'Ashirwad Shop'
  },
  businessCity: {
    type: String,
    default: 'Surat'
  },
  systemPrompt: {
    type: String,
    default: ''
  },
  offers: [{
    title: String,
    description: String,
    active: {
      type: Boolean,
      default: true
    }
  }],
  freeShipping: {
    type: Boolean,
    default: false
  },
  freeShippingAbove: {
    type: Number,
    default: 999
  },
  shippingCharge: {
    type: Number,
    default: 99
  }
});

const Settings = mongoose.model(
  'Settings',
  settingsSchema
);

async function getSettings() {
  try {
    let settings = await Settings.findOne({
      singleton: 'main'
    });
    if (!settings) {
      settings = new Settings({ singleton: 'main' });
      await settings.save();
    }
    return settings;
  } catch (error) {
    console.error('Settings error:', error.message);
    return null;
  }
}

module.exports = {
  connectDB,
  Customer,
  Settings,
  getSettings
};