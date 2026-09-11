const http = require('http')
const fs = require('fs')
const path = require('path')
const port = 8731
const root = __dirname
http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(root, urlPath === '/' ? 'index.html' : urlPath)
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  const ext = path.extname(file)
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.wav': 'audio/wav' }
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(port, () => console.log('serving on http://localhost:' + port))
