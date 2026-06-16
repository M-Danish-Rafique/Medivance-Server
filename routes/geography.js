const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// --- CITIES ---
router.get('/cities', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM cities ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/cities', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'City name required' });
    const [existing] = await db.query('SELECT id FROM cities WHERE LOWER(name)=LOWER(?)', [name]);
    if (existing.length) return res.status(409).json({ message: 'City already exists' });
    const [result] = await db.query('INSERT INTO cities (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'City already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/cities/:id', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'City name required' });
    const [existing] = await db.query('SELECT id FROM cities WHERE LOWER(name)=LOWER(?) AND id<>?', [name, req.params.id]);
    if (existing.length) return res.status(409).json({ message: 'City already exists' });
    await db.query('UPDATE cities SET name=? WHERE id=?', [name, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/cities/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM cities WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- AREAS ---
router.get('/areas', auth, async (req, res) => {
  try {
    const { city_id } = req.query;
    let sql = 'SELECT a.*, c.name as city_name FROM areas a JOIN cities c ON a.city_id = c.id';
    const params = [];
    if (city_id) { sql += ' WHERE a.city_id=?'; params.push(city_id); }
    sql += ' ORDER BY a.name';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/areas', auth, async (req, res) => {
  try {
    const { name, city_id } = req.body;
    if (!name || !city_id) return res.status(400).json({ message: 'Name and city required' });
    const [existing] = await db.query('SELECT id FROM areas WHERE LOWER(name)=LOWER(?) AND city_id=?', [name, city_id]);
    if (existing.length) return res.status(409).json({ message: 'Area already exists for this city' });
    const [result] = await db.query('INSERT INTO areas (name, city_id) VALUES (?,?)', [name, city_id]);
    res.status(201).json({ id: result.insertId, name, city_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Area already exists for this city' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/areas/:id', auth, async (req, res) => {
  try {
    const { name, city_id } = req.body;
    if (!name || !city_id) return res.status(400).json({ message: 'Name and city required' });
    const [existing] = await db.query('SELECT id FROM areas WHERE LOWER(name)=LOWER(?) AND city_id=? AND id<>?', [name, city_id, req.params.id]);
    if (existing.length) return res.status(409).json({ message: 'Area already exists for this city' });
    await db.query('UPDATE areas SET name=?, city_id=? WHERE id=?', [name, city_id, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/areas/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM areas WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- TERRITORIES ---
router.get('/territories', auth, async (req, res) => {
  try {
    const { area_id } = req.query;
    let sql = 'SELECT t.*, a.name as area_name, c.name as city_name FROM territories t JOIN areas a ON t.area_id=a.id JOIN cities c ON a.city_id=c.id';
    const params = [];
    if (area_id) { sql += ' WHERE t.area_id=?'; params.push(area_id); }
    sql += ' ORDER BY t.name';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/territories', auth, async (req, res) => {
  try {
    const { name, area_id } = req.body;
    if (!name || !area_id) return res.status(400).json({ message: 'Name and area required' });
    const [existing] = await db.query('SELECT id FROM territories WHERE LOWER(name)=LOWER(?) AND area_id=?', [name, area_id]);
    if (existing.length) return res.status(409).json({ message: 'Territory already exists for this area' });
    const [result] = await db.query('INSERT INTO territories (name, area_id) VALUES (?,?)', [name, area_id]);
    res.status(201).json({ id: result.insertId, name, area_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Territory already exists for this area' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/territories/:id', auth, async (req, res) => {
  try {
    const { name, area_id } = req.body;
    if (!name || !area_id) return res.status(400).json({ message: 'Name and area required' });
    const [existing] = await db.query('SELECT id FROM territories WHERE LOWER(name)=LOWER(?) AND area_id=? AND id<>?', [name, area_id, req.params.id]);
    if (existing.length) return res.status(409).json({ message: 'Territory already exists for this area' });
    await db.query('UPDATE territories SET name=?, area_id=? WHERE id=?', [name, area_id, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/territories/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM territories WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Combined geo data
router.get('/geo', auth, async (req, res) => {
  try {
    const [cities] = await db.query('SELECT * FROM cities ORDER BY name');
    const [areas] = await db.query('SELECT a.*, c.name as city_name FROM areas a JOIN cities c ON a.city_id=c.id ORDER BY a.name');
    const [territories] = await db.query('SELECT t.*, a.name as area_name, c.name as city_name FROM territories t JOIN areas a ON t.area_id=a.id JOIN cities c ON a.city_id=c.id ORDER BY t.name');
    res.json({ cities, areas, territories });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
