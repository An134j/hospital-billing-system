require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const pool = require('./db');
const Razorpay = require('razorpay');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const SECRET_KEY = process.env.JWT_SECRET || 'hospital123secret';

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/admin/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html'));
});

app.get('/admin/reports.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin/reports.html'));
});
app.get('/admin/cash-confirm.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin/cash-confirm.html'));
});
app.get('/patient/select-tests.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/patient/select-tests.html'));
});

app.get('/patient/patient-details.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/patient/patient-details.html'));
});

app.get('/patient/payment.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/patient/payment.html'));
});

app.get('/patient/success.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/patient/success.html'));
});

app.get('/patient/my-bills.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/patient/my-bills.html'));
});

// ========== AUTH MIDDLEWARE ==========
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Token nahi mila!' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalid hai!' });
  }
}

// ========== AUTH ROUTES ==========

app.post('/api/login/admin', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username aur password dono chahiye!' });
    }

    const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Wrong username or password' });
    }

    const admin = rows[0];
    const isValid = await bcrypt.compare(password, admin.password);

    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Wrong username or password' });
    }

    const token = jwt.sign(
      { id: admin.id, role: 'admin', name: admin.name },
      SECRET_KEY,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      role: 'admin',
      name: admin.name,
      token: token,
      message: 'Admin login successful'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

app.post('/api/login/patient', async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Mobile number chahiye!' });
    }

    const [rows] = await pool.query('SELECT * FROM patients WHERE mobile = ? ORDER BY id DESC LIMIT 1', [mobile]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const patient = rows[0];

    res.json({
      success: true,
      role: 'patient',
      name: patient.name,
      patientId: patient.id,
      age: patient.age,
      gender: patient.gender,
      mobile: patient.mobile,
      govt_id: patient.govt_id,
      address: patient.address,
      message: 'Patient login successful'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

// ========== TESTS ROUTES ==========

app.get('/api/tests', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tests');
    res.json({ success: true, tests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

// ========== BILLING ROUTES ==========
// Razorpay order banao
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100, // paise mein convert karo
      currency: 'INR',
      receipt: 'receipt_' + Date.now()
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      key: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Order create nahi hua!' });
  }
});
app.post('/api/bill/create', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { patientDetails, selectedTests, totalAmount, paymentMode } = req.body;

    if (!patientDetails || !selectedTests || selectedTests.length === 0 || !totalAmount || !paymentMode) {
      connection.release();
      return res.status(400).json({ success: false, message: 'Saari details bhejni zaruri hain!' });
    }

    await connection.beginTransaction();

    const [patientResult] = await connection.query(
      'INSERT INTO patients (govt_id, name, age, gender, mobile, address) VALUES (?, ?, ?, ?, ?, ?)',
      [patientDetails.govt_id, patientDetails.name, patientDetails.age, patientDetails.gender, patientDetails.mobile, patientDetails.address]
    );
    const patientId = patientResult.insertId;

    const billNo = 'BILL' + Date.now();

    const initialStatus = paymentMode === 'Cash' ? 'pending' : 'paid';

    const [billResult] = await connection.query(
      'INSERT INTO bills (bill_no, patient_id, total_amount, payment_mode, payment_status) VALUES (?, ?, ?, ?, ?)',
      [billNo, patientId, totalAmount, paymentMode, initialStatus]
    );
    const billId = billResult.insertId;

    for (const test of selectedTests) {
      await connection.query(
        'INSERT INTO bill_items (bill_id, test_id, test_name, price) VALUES (?, ?, ?, ?)',
        [billId, test.id, test.name, test.price]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, billNo: billNo, message: 'Bill created successfully' });

  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});
// Cash payment confirm karo (Staff/Admin desk pe)
app.put('/api/admin/bill/confirm-cash/:billNo', verifyToken, async (req, res) => {
  try {
    const { billNo } = req.params;

    const [bills] = await pool.query('SELECT * FROM bills WHERE bill_no = ?', [billNo]);
    if (bills.length === 0) {
      return res.status(404).json({ success: false, message: 'Bill nahi mila!' });
    }

    if (bills[0].payment_mode !== 'Cash') {
      return res.status(400).json({ success: false, message: 'Ye Cash payment bill nahi hai!' });
    }

    if (bills[0].payment_status === 'paid') {
      return res.status(400).json({ success: false, message: 'Ye bill already paid hai!' });
    }

    await pool.query('UPDATE bills SET payment_status = ? WHERE bill_no = ?', ['paid', billNo]);

    res.json({ success: true, message: 'Cash payment confirm ho gaya!' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

// Bill number se bill dhundo (Cash confirm karne ke liye)
app.get('/api/admin/bill/search/:billNo', verifyToken, async (req, res) => {
  try {
    const { billNo } = req.params;

    const [bills] = await pool.query('SELECT * FROM bills WHERE bill_no = ?', [billNo]);
    if (bills.length === 0) {
      return res.status(404).json({ success: false, message: 'Bill nahi mila!' });
    }

    const bill = bills[0];
    const [patients] = await pool.query('SELECT * FROM patients WHERE id = ?', [bill.patient_id]);
    const [items] = await pool.query('SELECT * FROM bill_items WHERE bill_id = ?', [bill.id]);

    res.json({
      success: true,
      bill: bill,
      patient: patients[0] || null,
      tests: items
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});
app.put('/api/admin/bill/cancel/:billNo', verifyToken, async (req, res) => {
  try {
    const { billNo } = req.params;

    const [bills] = await pool.query('SELECT * FROM bills WHERE bill_no = ?', [billNo]);
    if (bills.length === 0) {
      return res.status(404).json({ success: false, message: 'Bill nahi mila!' });
    }

    await pool.query('UPDATE bills SET payment_status = ? WHERE bill_no = ?', ['cancelled', billNo]);

    res.json({ success: true, message: 'Bill cancel ho gaya!' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

app.get('/api/admin/bills', verifyToken, async (req, res) => {
  try {
    const status = req.query.status;
    let query = 'SELECT * FROM bills';
    let params = [];

    if (status) {
      query += ' WHERE payment_status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.query(query, params);
    res.json({ success: true, bills: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});
app.get('/api/admin/patients', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM patients ORDER BY created_at DESC');
    res.json({ success: true, patients: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

app.get('/api/patient/bills/:patientId', async (req, res) => {
  try {
    const patientId = Number(req.params.patientId);

    const [patientRows] = await pool.query('SELECT mobile FROM patients WHERE id = ?', [patientId]);
    if (patientRows.length === 0) {
      return res.json({ success: true, bills: [] });
    }
    const mobile = patientRows[0].mobile;

    const [allPatientIds] = await pool.query('SELECT id FROM patients WHERE mobile = ?', [mobile]);
    const ids = allPatientIds.map(p => p.id);

    const [bills] = await pool.query('SELECT * FROM bills WHERE patient_id IN (?) ORDER BY created_at DESC', [ids]);

    const billsWithTests = [];
    for (const bill of bills) {
      const [items] = await pool.query('SELECT * FROM bill_items WHERE bill_id = ?', [bill.id]);
      billsWithTests.push({ ...bill, tests: items });
    }

    res.json({ success: true, bills: billsWithTests });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

app.get('/api/bill/pdf/:billNo', async (req, res) => {
  try {
    const { billNo } = req.params;

    const [bills] = await pool.query('SELECT * FROM bills WHERE bill_no = ?', [billNo]);
    if (bills.length === 0) {
      return res.status(404).json({ success: false, message: 'Bill nahi mila!' });
    }
    const bill = bills[0];

    const [patients] = await pool.query('SELECT * FROM patients WHERE id = ?', [bill.patient_id]);
    const patient = patients[0];

    const [items] = await pool.query('SELECT * FROM bill_items WHERE bill_id = ?', [bill.id]);

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${billNo}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).fillColor('#1a73e8').text('Hospital Test & Billing System', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).fillColor('#000').text(`Bill No: ${billNo}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).fillColor('#1a73e8').text('Patient Details:');
    doc.fillColor('#000');
    doc.text(`Name: ${patient ? patient.name : 'N/A'}`);
    doc.text(`Age: ${patient ? patient.age : 'N/A'}`);
    doc.text(`Gender: ${patient ? patient.gender : 'N/A'}`);
    doc.text(`Mobile: ${patient ? patient.mobile : 'N/A'}`);
    doc.text(`Govt ID: ${patient ? patient.govt_id : 'N/A'}`);
    doc.moveDown();

    doc.fontSize(12).fillColor('#1a73e8').text('Tests:');
    doc.fillColor('#000');
    items.forEach(item => {
      doc.text(`${item.test_name} - Rs.${item.price}`);
    });
    doc.moveDown();

    doc.fontSize(14).fillColor('#2e7d32').text(`Total Amount: Rs.${bill.total_amount}`);
    doc.text(`Payment Mode: ${bill.payment_mode}`);
    doc.text(`Status: ${bill.payment_status}`);
    doc.moveDown();

    doc.fontSize(10).fillColor('#888').text(`Date: ${new Date(bill.created_at).toLocaleString('en-IN')}`, { align: 'right' });
    doc.text('Thank you for visiting!', { align: 'center' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error!' });
  }
});

app.listen(3000, () => {
  console.log('✅ Server chal raha hai: http://localhost:3000');
});