const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  });

  const mailOptions = {
    from: 'aaddii091@gmail.com',
    to: 'aaddii093@gmail.com',
    subject: 'Hello from Nodemailer',
    text: 'This is a test email sent using Nodemailer.',
  };

  transporter.sendMail(mailOptions);
};

module.exports = sendEmail;
