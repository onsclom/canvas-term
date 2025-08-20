import { playBootupSound } from "./bootup-sound"
import font from "./monogram.ttf"

{
  const fontFace = new FontFace('monogram', `url(${font})`);
  await fontFace.load()
  document.fonts.add(fontFace)
}

const loadTime = 2000

const state = {
  focused: false,
  loadTimer: 0,
  text: [
    `WELCOME TO THE CANVAS TERMINAL`
  ],
  prompt: '',
}
const promptMarker = '> '

document.onclick = () => {
  if (!state.focused) {
    state.focused = true;
  }
}

let previousTime = 0
export function renderTerminalToOffscreen(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  webglCanvas: HTMLCanvasElement,
) {
  const newTime = performance.now()
  const dt = newTime - previousTime
  previousTime = newTime

  if (!ctx) {
    console.error('Failed to get offscreen canvas context')
    return
  }

  const canvasRect = webglCanvas.getBoundingClientRect()
  canvas.width = canvasRect.width * window.devicePixelRatio
  canvas.height = canvasRect.height * window.devicePixelRatio
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio)


  ctx.fillStyle = `#000000`
  ctx.fillRect(0, 0, canvasRect.width, canvasRect.height)
  const textHeight = 16 * 3
  const lineSpacing = 0;
  ctx.font = `${textHeight}px monogram`
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const charWidth = ctx.measureText(' ').width;

  const margin = textHeight * .5
  ctx.translate(margin, margin)

  let cursorY = lineSpacing
  const x = 0;

  if (!state.focused) {
    ctx.fillText(`click to start`, x, cursorY)
  }
  else if (state.loadTimer < loadTime) {
    state.loadTimer += dt

    // text loading bar
    // [=====     ] 50%
    const loadProgress = Math.min(1, state.loadTimer / loadTime);
    const loadingBarSize = 10
    const equalSigns = Math.floor(loadingBarSize * loadProgress)
    const spaces = loadingBarSize - equalSigns;


    const maxDotAmount = 3
    const dotAmount = Math.floor((state.loadTimer * .005) % (maxDotAmount + 1))
    const lines = [
      `[${'='.repeat(equalSigns)}${' '.repeat(spaces)}] ${Math.round(loadProgress * 100)}%`,
      `booting${'.'.repeat(dotAmount)}`,
    ]

    for (const line of lines) {
      ctx.fillText(line, x, cursorY)
      cursorY += textHeight + lineSpacing
    }

    if (state.loadTimer >= loadTime) {
      // finished loading, can start boot sound!
      playBootupSound()
    }

  } else {
    for (const line of state.text) {
      ctx.fillText(line, x, cursorY)
      cursorY += textHeight + lineSpacing
    }
    const promptLine = `${promptMarker}${state.prompt}`;
    ctx.fillText(promptLine, x, cursorY)

    const cursorVerticalShrink = textHeight * .2;
    const showCursor = Math.floor(performance.now() * (.003)) % 2 === 0;
    if (showCursor) {
      ctx.fillRect(
        x + charWidth * (promptLine.length),
        cursorY + cursorVerticalShrink * .5,
        charWidth,
        textHeight - cursorVerticalShrink
      )
    }
  }
}

window.onkeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    state.text.push(
      `${promptMarker}${state.prompt} ` // Echo the prompt
    )
    const trimmedInput = state.prompt.trim();
    const command = trimmedInput.split(' ')[0]

    if (command === 'help') {
      state.text.push('[HELP TEXT HERE]');
    }
    else if (command === 'clear') {
      state.text = [];
    }
    else if (trimmedInput === '') {
    }
    else {
      state.text.push(`Unknown command: ${command} `);
    }
    state.prompt = '';
  } else if (event.key === 'Backspace') {
    state.prompt = state.prompt.slice(0, -1);
  } else if (event.key.length === 1) {
    state.prompt += event.key;
  }
}
