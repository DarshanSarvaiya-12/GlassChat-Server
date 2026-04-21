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

// Customer Schema
const customerSchema = new mongoose.Schema({
  
  // IDENTITY
  phone: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    default: null
  },
  contactNumber: {
    type: String,
    default: null
  },
  
  // CURRENT SESSION
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
        'completed'
      ],
      default: 'new'
    },
    
    // CART ITEMS
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
    
    // DELIVERY INFO
    deliveryAddress: {
      type: String,
      default: null
    },
    
    // PRICE SUMMARY
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
    
    // CONVERSATION HISTORY
    // Last 20 messages only
    conversationHistory: {
      type: Array,
      default: []
    },
    
    // AUTO EXPIRE after 7 days
    expiresAt: {
      type: Date,
      default: () => new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
      index: { expires: 0 }
    }
  },
  
  // ORDER HISTORY
  orders: [{
    orderId: {
      type: String,
      default: () => 'ORD-' + Date.now()
    },
    date: {
      type: Date,
      default: Date.now
    },
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: Number,
      pricePerItem: Number,
      totalPrice: Number
    }],
    deliveryAddress: String,
    orderTotal: Number,
    deliveryCharge: Number,
    grandTotal: Number,
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid'],
      default: 'pending'
    },
    deliveryStatus: {
      type: String,
      enum: [
        'pending',
        'processing',
        'shipped',
        'delivered'
      ],
      default: 'pending'
    }
  }],
  
  // VISIT TRACKING
  firstVisit: {
    type: Date,
    default: Date.now
  },
  lastVisit: {
    type: Date,
    default: Date.now
  },
  totalVisits: {
    type: Number,
    default: 1
  },
  
  // PREFERENCES
  // Learned automatically over time
  preferences: {
    sizes: {
      type: Object,
      default: {}
    },
    colors: {
      type: [String],
      default: []
    }
  }
  
});

const Customer = mongoose.model(
  'Customer',
  customerSchema
);
// Settings Schema
const settingsSchema = new mongoose.Schema({
  // Only one settings document
  singleton: {
    type: String,
    default: 'main',
    unique: true
  },

  // Business Info
  businessName: {
    type: String,
    default: 'My Shop'
  },
  businessCity: {
    type: String,
    default: 'Surat'
  },

  // System Prompt
  systemPrompt: {
    type: String,
    default: ''
  },

  // Offers
  offers: [{
    title: String,
    description: String,
    active: {
      type: Boolean,
      default: true
    }
  }],

  // Shipping
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

// Get or create settings
async function getSettings() {
  try {
    let settings = await Settings.findOne({
      singleton: 'main'
    });
    if (!settings) {
      settings = new Settings({
        singleton: 'main'
      });
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

module.exports = { connectDB, Customer };