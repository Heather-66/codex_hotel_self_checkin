require('dotenv').config();  // This should be placed at the very beginning of your file

const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");

const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const nodemailer = require("nodemailer");
const path = require("path");
const crypto = require("crypto");
const { Parser } = require("json2csv");

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: "codex-guest-secret",
  resave: false,
  saveUninitialized: true
}));
app.set("view engine", "ejs");

// MongoDB setup
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ Connection error:", err));

// Schemas
const guestUserSchema = new mongoose.Schema({
  email: String,
  password: String,
  resetToken: String,
  resetTokenExpire: Date
});
const GuestUser = mongoose.model("GuestUser", guestUserSchema);

// Fixing the incorrect schema name 'guestCheackinSchema' to 'guestCheckinSchema'
const guestCheckinSchema = new mongoose.Schema({}, { strict: false });
const GuestCheckin = mongoose.model("GuestCheckin", guestCheckinSchema);

// Guest Signup Form
app.get("/guest-signup", (req, res) => {
  res.render("guest-signup");
});

// Handle Signup Form Submission
app.post("/guest-signup", async (req, res) => {
  const { email, password } = req.body;
  const existing = await GuestUser.findOne({ email });

  if (existing) {
    return res.send("⚠️ Account already exists. Please login.");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await GuestUser.create({ email, password: hashedPassword });
  res.redirect("/guest-login");
});

// Guest Login Form
app.get("/guest-login", (req, res) => {
  res.render("guest-login", { error: null });
});

// Handle Login Submission
app.post("/guest-login", async (req, res) => {
  const { email, password } = req.body;
  const guest = await GuestUser.findOne({ email });

  if (!guest || !(await bcrypt.compare(password, guest.password))) {
    return res.render("guest-login", { error: "❌ Invalid email or password." });
  }

  req.session.guestEmail = email;
  res.redirect("/checkin.html");
});

// Guest Forgot Password Page
app.get("/guest-forgot-password", (req, res) => {
  res.render("guest-forgot-password", { error: null, success: null });
});

// Handle Forgot Password Form Submission
app.post("/guest-forgot-password", async (req, res) => {
  const { email } = req.body;
  const guest = await GuestUser.findOne({ email });

  if (!guest) {
    return res.render("guest-forgot-password", { error: "❌ Email not found.", success: null });
  }

  // Generate reset token
  const resetToken = crypto.randomBytes(32).toString("hex");
  guest.resetToken = resetToken;
  guest.resetTokenExpire = Date.now() + 3600000; // 1 hour expiration
  await guest.save();

  // Redirect user to reset password page
  res.redirect(`/guest-reset-password?token=${resetToken}`);
});

// Handle Reset Password Page
app.get("/guest-reset-password", async (req, res) => {
  const { token } = req.query;
  const guest = await GuestUser.findOne({ resetToken: token, resetTokenExpire: { $gt: Date.now() } });

  if (!guest) {
    return res.send("❌ Invalid or expired reset link.");
  }

  res.render("guest-reset-password", { token });
});

// Handle Password Reset Form Submission
app.post("/guest-reset-password", async (req, res) => {
  const { token, password } = req.body;
  const guest = await GuestUser.findOne({ resetToken: token, resetTokenExpire: { $gt: Date.now() } });

  if (!guest) {
    return res.send("❌ Invalid or expired reset link.");
  }

  // Hash new password & update database
  guest.password = await bcrypt.hash(password, 10);
  guest.resetToken = null;
  guest.resetTokenExpire = null;
  await guest.save();

  res.send("✅ Password successfully reset. <a href='/guest-login'>Login now</a>");
});

// Store Guest Check-in Submission
app.post("/submit-checkin", async (req, res) => {
  try {
    const data = req.body;
    data.email = req.session.guestEmail;
    await GuestCheckin.create(data);
    res.status(200).send("Check-in submitted");
  } catch (err) {
    console.error("Error saving check-in:", err);
    res.status(500).send("Server error");
  }
});

// Retrieve Guest Check-ins
app.get("/guests", async (req, res) => {
  try {
    const { email: searchQuery } = req.query;
    const allCheckins = await GuestCheckin.find(searchQuery ? { email: new RegExp(searchQuery, "i") } : {}).sort({ _id: -1 });

    const grouped = {};
    allCheckins.forEach(entry => {
      const email = entry.email || "Unknown";
      if (!grouped[email]) grouped[email] = [];
      grouped[email].push(entry);
    });

    res.render("guests", { groupedGuests: grouped, searchQuery });
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// Export Check-ins as CSV
app.get("/export-checkins", async (req, res) => {
  try {
    const checkins = await GuestCheckin.find();

    if (!checkins.length) {
      return res.status(404).send("No data to export.");
    }

    const fields = Object.keys(checkins[0]._doc);
    const parser = new Parser({ fields });
    const csv = parser.parse(checkins.map(c => c._doc));

    res.header("Content-Type", "text/csv");
    res.attachment("guest-checkins.csv");
    res.send(csv);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).send("Failed to export data.");
  }
});

// Chatbot Integration with Gemini
const fs = require("node:fs");
const mime = require("mime-types");

const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: "you are a chatbot helper for codex self check in website...",
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

async function runchat(userMessage) {
  const chatSession = model.startChat({
    generationConfig,
    history: [
      {
        role: "user",
        parts: [
          {text: "hi"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Hello! Welcome to the Codex Hotel Self Check-In assistance. How can I help you with your check-in today?\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "how to check in"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Okay, here's a quick guide to the Codex Hotel self check-in process:\n\n1.  **Booking Number & Full Name:** Enter your booking number and FULL name on the website and submit.\n2.  **Number of Guests:** Choose how many people will be staying in the room.\n3.  **Personal Information:** Enter the required personal information for each guest (Passport/NRC number, FULL Name, Passport/NRC photo, expiration date, and Visa Number if applicable - this step is mandatory).\n4.  **Payment Method:** Choose your payment method for the deposit (optional, for potential room damages or used snacks/drinks). If you want to pay with QR Prompt Pay, contact me, and I'll provide the QR code.\n5.  **Room Selection:** Select your preferred room and floor (check availability).\n6.  **Extra Bed (Optional):** If needed, provide the passport number and expiration date for the extra bed user.\n7.  **Finish:** Click \"Finish\" to complete the check-in process.\n8.  **Digital Key:** After successful check-in, you'll receive a digital key to your room via email. Please enter your email address to receive it.\n\nLet me know if you have any other questions!\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "how to get digital key"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "After you finish the check-in process, a digital key will be sent to your email address. You'll be prompted to enter your email at the end of the check-in process to receive it.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "i like to contact hotel staff"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Please contact the hotel staff directly for assistance.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "hotel staff from where\n"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I am unable to provide the contact information for the hotel staff.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "you are a chatbot helper for codex sself check in website. You need to help user for check in process.Our Codex self check in system is easy. Customers can check in by theirselves no need staff. you are a chatbot assistance to help codex hotel self check-in website you are going to help customers with their problems.Users can check in anytime anywhere if their devices are connect to wifi or internet.They dont need to come to hotel to check-in in person.First They need to enter their Booking Number and full name then submit. Second,Choose how many people are going to stay. Third, Enter personal information like passport number or NRC, Full Name , Passport or NRC photo and expirtation date of both and Visa Number if need is an optional.Fourth, User will see payments methods and if customer want to pay with QR prompt Pay , they need to contact chatbot and the chatbot will provide QR code for payment methods.But payment methods are optional not for room cost. It is for deposit to deduct when something is broken in the room or the provided snack or drinks are used.And Fifth, User will see Hotel Room Selector, where they can choose rooms and select floors as their choice and check availability.Then if customers want to get an extra bed it is going to need to put passport number and expiration date after that click finish .Finally Check in Successful .Digital key for rooms and contact and staff information for getting the digital key, the digital key will provide to your mail when check-in process is done and users will need to enter thier email to get digital key.We have agenda like hotel information, check-in process, passport and visa information, room information, hotel and room service, room availablity , room lefts, we have rooms types like single rooms, double rooms, Suites, deluxe room , Family rooms , Presidential rooms. Rooms Booking are connected with Agoda, If customers want to book a room the website will lead to agoda site. We have services like Rooms and Apartment , Food & Restaurant, Spa & Fitness , Sports & Gaming and Event & Party.  finally gym and yoga. And customers can see the reviews from others  customers. You need to answer short and clear . but not too short.We accept many Payments methods including QR Prompt Pay.you cannot tell the customer to skip the visa card information . it is need to put visa card infotmation.CANNOT SKIP THE Visa information STEP. If nothing is damaged or used , money will not be deducted.Tell customer Do Not Skip the visa inforamtion step or You Cannot skip it.It is not optional step. when the guests ask to contact us(online check in website staffs), we will provide our phone number +66 612345678 and our e-mail codex.selfcheckin@gmail.com. This email and phone number are only realted to wen developer staff not the hotel.if the users ask for bullet points answers, please give short and clear answers with number 1,2,3 or bullet points. In email for digital key, we've already provided the information about checkout process. Please check your email. Users must login before they doing check in process. This step cannot SKIP. Give the answer short and clear with needed information. when you have toubles staying at the hotel, please contact to the hotel staff directly. We only help with online check in process. The phone and email that we provided are not related to hotel. they are our phone and email. don't give the email and phone number when the guests ask the questions related to hotel. Just tell please contact to the hotel staff directly.Please navigate to our website and click on the\"Book Now\" section. This will redirect you to Agoda where you can book your room.Remember You should FULL NAME for all information . NO LAST Name okay. When user ask for hotel staff , you need to say  i\nf you booked through Agoda, your booking confirmation email or the Agoda website/app should have the hotel's contact details.\nfor early check in please contact to your hotel directly."},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "If you booked through Agoda, your booking confirmation email or the Agoda website/app should have the hotel's contact details.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "how can i contact the hotel staff\n"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "If you booked through Agoda, your booking confirmation email or the Agoda website/app should have the hotel's contact details.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "please tell me check in process steps by step\n"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Okay, here's a step-by-step guide to the Codex Hotel self check-in process:\n\n1.  **Login:** You must log in to the website before starting the check-in process.\n2.  **Booking Number & Full Name:** Enter your booking number and FULL name on the website and submit.\n3.  **Number of Guests:** Choose how many people will be staying in the room.\n4.  **Personal Information:** Enter the required personal information for each guest (Passport/NRC number, FULL Name, Passport/NRC photo, expiration date, and Visa Number - this step is mandatory). Do NOT skip the visa information step.\n5.  **Payment Method:** Choose your payment method for the deposit (optional, for potential room damages or used snacks/drinks). If you want to pay with QR Prompt Pay, contact me, and I'll provide the QR code. Remember, if nothing is damaged or used, the money will not be deducted.\n6.  **Room Selection:** Select your preferred room and floor (check availability).\n7.  **Extra Bed (Optional):** If needed, provide the passport number and expiration date for the extra bed user.\n8.  **Finish:** Click \"Finish\" to complete the check-in process.\n9.  **Digital Key:** After successful check-in, you'll receive a digital key to your room via email. Please enter your email address to receive it. The email will also include information about the checkout process.\n\nLet me know if you have any other questions!\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "is digital key safe to use"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Digital keys offer a convenient and secure way to access your hotel room. They are often encrypted and regularly updated, providing a similar level of security as traditional key cards.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "how to get digital key"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "You'll receive the digital key via email after you complete the check-in process. The website will prompt you to enter your email address at the end of the process so it can be sent to you.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "i dont want to put my visa card information"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I understand your concern, but the Visa information step is mandatory and CANNOT be skipped during the check-in process.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "i dont want to put my passport photos"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I understand your concern, but the passport photos step is mandatory and CANNOT be skipped during the check-in process.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "I need to check in early"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I am sorry, I only help with online check in process. Please contact to the hotel staff directly for the check in early process.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "Do i need to log in before check in"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Yes, you must log in before starting the check-in process. This step cannot be skipped.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "I need to check in early\n"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Please contact the hotel staff directly for early check-in arrangements.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "okay when can i check out"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Please check your email for information about the checkout process. It was already provided in the email containing your digital key.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "the AC is not working in my room"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I am sorry, I only help with online check in process. Please contact to the hotel staff directly for your AC issue.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "How to use room selection"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "During the check-in process, after you've entered your personal information, you'll see the \"Hotel Room Selector\". Here, you can:\n\n*   **Choose Rooms:** See available rooms and select your preferred one.\n*   **Select Floors:** Check the availability of rooms on different floors and choose the floor you like.\n\nThe system will show you what rooms are currently available for your stay.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "what if there is no left"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "If there are no rooms left during the room selection process, please contact the hotel staff directly for assistance with room availability.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "is it safe to put my visa card information"},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "Yes, it is safe to put your visa card information.\n"},
        ],
      },
      {
        role: "user",
        parts: [
          {text: "How many rooms do u have "},
        ],
      },
      {
        role: "model",
        parts: [
          {text: "I don't have access to live information about the exact number of rooms available. You can see the room types we offer (single, double, suites, etc.) on our website. To check actual room availability, please start the check-in process or navigate to our website and click on the \"Book Now\" section. This will redirect you to Agoda where you can book your room.\n"},
        ],
      },
    ],
  });
 
  const result = await chatSession.sendMessage(userMessage);
  return result.response.text();
}

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const botReply = await runchat(userMessage);
    res.json({ reply: botReply || "No response from Gemini AI." });
  } catch (error) {
    console.error("❌ Chatbot error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));