import './capture.css'

const image = document.querySelector<HTMLImageElement>('#image')!
window.ovseer.onCaptureImage((dataUrl) => { image.src = dataUrl })
image.addEventListener('dragstart', (event) => {
  event.preventDefault()
  window.ovseer.captureDrag()
})
document.querySelector('#close')!.addEventListener('click', () => window.ovseer.captureClose())
