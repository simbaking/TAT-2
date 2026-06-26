require('dotenv').config();
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'changfourafrica@gmail.com',
        pass: process.env.EMAIL_PASSWORD
    }
});
const mailOptions = {
    from: 'changfourafrica@gmail.com',
    to: 'changfourafrica@gmail.com',
    subject: 'test',
    text: 'test'
};
transporter.sendMail(mailOptions).then(() => console.log('Success')).catch(err => console.error('Error:', err.message));
