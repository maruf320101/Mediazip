# ⚡ MediaZip - All-in-One Social Media Video Downloader

<p align="center">
  <b>Fast, high-resolution video and audio downloader for YouTube, Facebook, and TikTok.</b><br/>
  Clean glassmorphism dark & light UI, zero watermarks, and 100% free.
</p>

---

## 🌟 Key Features

- **Multi-Platform Support**:
  - 🔴 **YouTube**: 4K Ultra HD, 1080p Full HD, 720p HD, 480p, 360p, and MP3 audio extraction.
  - 🔵 **Facebook**: HD & SD public posts, reels, and stories.
  - ⚫ **TikTok**: Original HD downloads **without watermark** + audio extraction.
- **High-Speed Processing**:
  - In-memory metadata caching.
  - Multi-threaded parallel stream chunking (`yt-dlp` optimization).
  - Fast response times without unnecessary delays.
- **Modern Responsive UI**:
  - Glassmorphism design with sleek gradients.
  - Real-time dark / light mode toggle.
  - Dynamic video preview card (thumbnails, title, channel/creator, duration, file size estimation).
  - Mobile, tablet, and desktop responsive.
- **100% Self-Hosted & Free**:
  - No external paid API subscriptions needed.
  - Direct local backend utilizing `yt-dlp` and `ffmpeg`.

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3 (Custom Glassmorphism design tokens), Vanilla JavaScript (ES6+), FontAwesome Icons.
- **Backend**: Node.js, Express.js.
- **Core Engine**: `yt-dlp` (Python CLI), `ffmpeg` (media transcoding/merging).

---

## 🚀 Getting Started

### Prerequisites

Make sure you have the following installed on your machine:
1. [Node.js](https://nodejs.org/) (v18 or higher)
2. [Python](https://www.python.org/) (v3.10+ with `pip` added to PATH)
3. [ffmpeg](https://ffmpeg.org/) (Required for high-resolution video merging)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/maruf320101/Mediazip.git
   cd Mediazip
   ```

2. **Run Installer (Windows)**:
   Double-click `install.bat` or run:
   ```bash
   npm install
   pip install -U yt-dlp
   ```

3. **Start the Application**:
   Double-click `start.bat` or run:
   ```bash
   node server.js
   ```

4. **Open in Browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

---

## 📁 Project Structure

```text
├── index.html        # Main landing page & UI components
├── style.css         # Glassmorphism design system & responsiveness
├── script.js         # Frontend client logic & real API integration
├── server.js         # Express server & yt-dlp execution pipeline
├── package.json      # Node.js dependencies
├── Dockerfile        # Container setup for Docker deployment
├── railway.json      # Cloud deployment configuration
├── install.bat       # Automatic 1-click Windows installer
├── start.bat         # Automatic 1-click server launch
└── README.md         # Project documentation
```

---

## ⚖️ Disclaimer

MediaZip is intended for personal and educational use only. Please respect copyright laws and the terms of service of YouTube, Facebook, and TikTok. Content downloaded using this application belongs to its respective copyright owners.
