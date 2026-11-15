# multiWheels

A small browser-based multiplayer physics sim built with Node.js. Two clients can load the page and control wheels in the same environment.

## TODO:

- Scoring/game system, probably start with "tag" mode
- Add a "hazard" wall type
- Improve the physics
- 

## Requirements

- Node.js 18 or newer
- npm

## Install

From the project root, install the dependencies:

```bash
npm install
```

## Run

Start the server:

```bash
npm start
```

Then open http://localhost:3000 in two separate browser windows or tabs to play.

To play from other devices use the host computer's local IP in place of "localhost". For example: ``http:/192.168.1.555:3000``

To run in watch mode while developing:

```bash
npm run dev
```

## Custom port

If port 3000 is already in use, start the server with a different port:

```bash
PORT=4000 npm start
```

On Windows PowerShell:

```powershell
$env:PORT = 4000
npm start
```
