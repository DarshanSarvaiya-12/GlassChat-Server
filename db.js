const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected!');
  } catch (error) {
    console.error('MongoDB error:', error.message);
  }
};

const customerSchema = new mongoose.Schema({

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

  session: {
    stage: {
      type: String,
      enum: [
        'new',
        'welcomed',
        'size_selected',
        'browsing',
        'item_selecting',
        'awaiting_more',
        'payment_method',
        'awaiting_payment',
        'cod_address',
        'online_address',
        'awaiting_confirmation',
        'completed'
      ],
      default: 'new'
    },

    selectedSize: {
      type: String,
      default: null
    },

    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: {
        type: Number,
        default: 1
      },
      pricePerItem: Number,
      totalPrice: Number
    }],

    currentItem: {
      type: Object,
      default: null
    },

    paymentMethod: {
      type: String,
      default: null
    },

    deliveryAddress: {
      type: String,
      default: null
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

    conversationHistory: {
      type: Array,
      default: []
    },

    expiresAt: {
      type: Date,
      default: () => new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
      index: { expires: 0 }
    }
  },

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
      enum: ['pending', 'paid', 'cod'],
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