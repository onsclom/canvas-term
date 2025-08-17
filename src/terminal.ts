
const state = {
  text: [
    `WELCOME TO THE CANVAS TERMINAL`
  ],
  prompt: '',
}
const promptMarker = '> '

export function renderTerminalToOffscreen(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  webglCanvas: HTMLCanvasElement,
) {
  if (!ctx) {
    console.error('Failed to get offscreen canvas context')
    return
  }

  const canvasRect = webglCanvas.getBoundingClientRect()
  canvas.width = canvasRect.width * window.devicePixelRatio
  canvas.height = canvasRect.height * window.devicePixelRatio
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const textHeight = 16
  const lineSpacing = textHeight * .5;
  ctx.font = `${textHeight}px monospace`
  ctx.fillStyle = '#0F0'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const charWidth = ctx.measureText(' ').width;

  let cursorY = lineSpacing
  const x = lineSpacing; // left padding
  for (const line of state.text) {
    ctx.fillText(line, x, cursorY)
    cursorY += textHeight + lineSpacing
  }
  const promptLine = `${promptMarker}${state.prompt}`;
  ctx.fillText(promptLine, x, cursorY)
  ctx.fillRect(x + charWidth * (promptLine.length), cursorY, charWidth, textHeight);
}

window.onkeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    state.text.push(
      `${promptMarker}${state.prompt}` // Echo the prompt
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
      state.text.push(`Unknown command: ${command}`);
    }
    state.prompt = '';
  } else if (event.key === 'Backspace') {
    state.prompt = state.prompt.slice(0, -1);
  } else if (event.key.length === 1) {
    state.prompt += event.key;
  }
}
