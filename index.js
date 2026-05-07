const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

function loadDotEnv(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();

      if (!key) continue;

      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore .env parsing errors; environment variables may be set by the runtime.
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Load env vars before importing workers (workers reads process.env.*)
loadDotEnv(path.join(__dirname, '.env'));
const workers = require('./workers');

// Ensure the uploads directory exists for media files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer configuration for handling file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve the index.html file at the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route to handle the form submission
app.post('/post', upload.single('media'), async (req, res) => {
  const { text } = req.body;
  const media = req.file;
  const platformsRaw = req.body.platforms;
  const platforms = Array.isArray(platformsRaw)
    ? platformsRaw
    : platformsRaw
      ? [platformsRaw]
      : [];

  try {
    const message = await workers.postToBuffer(text, media, { platforms });
    res.json([{ platform: 'Buffer', status: 'Success', message }]);
  } catch (error) {
    console.error('Buffer Posting Error:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    res.status(500).json([{ platform: 'Buffer', status: 'Error', message: error.message }]);
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
