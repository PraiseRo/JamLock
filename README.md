# JamBeat - Realtime Synchronized Music Player

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.8%2B-black.svg)](https://socket.io/)

A fast, responsive web application where friends can listen to music together in real-time rooms for free.

## ✨ Features
- **100% Free**: No Spotify Premium required; streams any track, remix, or live set.
- **Sub-Second Fast Search**: Instant debounced search with in-memory caching.
- **Real-Time Synchronization**: Play, pause, seek, and track transitions sync in real-time across all connected listeners with automatic drift correction.
- **Shared Collaborative Queue**: Anyone can search and queue songs to play next.
- **Live Room Interaction**: Real-time room chat and floating reaction bursts (🔥, ❤️, 💃, 🎉).
- **Modern Responsive Design**: Dark mode aesthetic, ambient album glow, animated vinyl disc, and mobile-friendly controls.

## 🚀 How to Run

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Open in browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

4. **Listen Together**:
   - Create a room (e.g. `ROOM-ABCD`).
   - Copy the invite link from the header badge and send it to your friends or open it in a private browser window.
   - Search for any song in the search bar (or press `Ctrl+K`).
   - Click "Queue" or "Next" to start playing together in sync!

## ⚖️ Disclaimer & Fair Use

- **Third-Party Content**: JamBeat does not host, upload, or re-stream copyrighted media files. All playback is rendered directly on client devices via the YouTube IFrame API in accordance with YouTube Terms of Service.
- **Intellectual Property**: All music, artist names, trademarks, and album artwork remain the property of their respective copyright holders.
- **Educational / Open Source**: JamBeat is an open-source demonstration of real-time WebSocket state synchronization, provided "as is" under the MIT License without warranty.
