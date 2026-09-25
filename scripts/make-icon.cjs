// Gera build/icon.png (1024×1024) a partir de build/logo-src.png.
// Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const logo = fs.readFileSync(path.join(__dirname, '../build/logo-src.png')).toString('base64')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const S = 1024, M = 100, R = 185
      const c = document.createElement('canvas'); c.width = c.height = S
      const g = c.getContext('2d')
      g.shadowColor = 'rgba(40, 20, 80, 0.28)'; g.shadowBlur = 36; g.shadowOffsetY = 12
      const grad = g.createLinearGradient(0, M, 0, S - M)
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#f1eafe')
      g.fillStyle = grad
      g.beginPath(); g.roundRect(M, M, S - 2 * M, S - 2 * M, R); g.fill()
      g.shadowColor = 'transparent'
      const img = new Image()
      img.onload = () => {
        // o PNG original tem margem; recorta o conteúdo e centraliza
        const src = 540, cx = 328, cy = 325, sx = cx - src / 2, sy = cy - src / 2
        const dst = 660
        g.drawImage(img, sx, sy, src, src, (S - dst) / 2, (S - dst) / 2, dst, dst)
        resolve(c.toDataURL('image/png'))
      }
      img.src = 'data:image/png;base64,${logo}'
    })
  `)
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('build/icon.png gerado')
  app.quit()
})
