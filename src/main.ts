import './style.css'
import { renderTerminalToOffscreen } from './terminal'

export const offscreenCanvas = new OffscreenCanvas(0, 0)
export const offscreenCtx = offscreenCanvas.getContext('2d')!

// Create WebGL canvas for display
const webglCanvas = document.createElement('canvas')
document.body.appendChild(webglCanvas)
const gl = webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl')

if (!gl) {
  throw new Error('WebGL not supported')
}

// Vertex shader source (shared by all programs)
const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
uniform bool u_flipY;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = u_flipY ? vec2(a_texCoord.x, 1.0 - a_texCoord.y) : a_texCoord;
}
`

// Base fragment shader that just blits the texture
const baseFragmentShaderSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;

void main() {
  gl_FragColor = texture2D(u_texture, v_texCoord);
}
`

// Bright pass shader - extracts bright pixels
const brightPassFragmentShaderSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_threshold;

void main() {
  vec4 color = texture2D(u_texture, v_texCoord);
  float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));

  if (luminance > u_threshold) {
    gl_FragColor = color;
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
}
`

// Gaussian blur shader (separable)
const blurFragmentShaderSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform vec2 u_direction;
uniform vec2 u_resolution;

void main() {
  vec2 texelSize = 1.0 / u_resolution;
  vec4 color = vec4(0.0);

  // Gaussian weights for 9-tap blur
  float weights[5];
  weights[0] = 0.227027;
  weights[1] = 0.1945946;
  weights[2] = 0.1216216;
  weights[3] = 0.054054;
  weights[4] = 0.016216;

  // Sample center
  color += texture2D(u_texture, v_texCoord) * weights[0];

  // Sample both directions
  for(int i = 1; i < 5; i++) {
    vec2 offset = u_direction * texelSize * float(i);
    color += texture2D(u_texture, v_texCoord + offset) * weights[i];
    color += texture2D(u_texture, v_texCoord - offset) * weights[i];
  }

  gl_FragColor = color;
}
`

// Final combine shader
const combineFragmentShaderSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_original;
uniform sampler2D u_bloom1;
uniform sampler2D u_bloom2;
uniform sampler2D u_bloom3;
uniform float u_bloomIntensity;

void main() {
  vec4 original = texture2D(u_original, v_texCoord);
  vec4 bloom1 = texture2D(u_bloom1, v_texCoord);
  vec4 bloom2 = texture2D(u_bloom2, v_texCoord);
  vec4 bloom3 = texture2D(u_bloom3, v_texCoord);

  vec4 bloom = (bloom1 + bloom2 + bloom3) * u_bloomIntensity;
  gl_FragColor = original + bloom;
}
`

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Error compiling shader:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    throw new Error('Failed to compile shader')
  }

  return shader
}

function createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Error linking program:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    throw new Error('Failed to link program')
  }

  return program
}

function createTexture(gl: WebGLRenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

function createFramebuffer(gl: WebGLRenderingContext, texture: WebGLTexture): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer not complete')
  }

  return framebuffer
}

// Create shared vertex shader
const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)

// Create all shader programs
const baseProgram = createProgram(gl, vertexShader, createShader(gl, gl.FRAGMENT_SHADER, baseFragmentShaderSource))
const brightPassProgram = createProgram(gl, vertexShader, createShader(gl, gl.FRAGMENT_SHADER, brightPassFragmentShaderSource))
const blurProgram = createProgram(gl, vertexShader, createShader(gl, gl.FRAGMENT_SHADER, blurFragmentShaderSource))
const combineProgram = createProgram(gl, vertexShader, createShader(gl, gl.FRAGMENT_SHADER, combineFragmentShaderSource))

// Get all uniform and attribute locations
const baseUniforms = {
  texture: gl.getUniformLocation(baseProgram, 'u_texture')!,
  flipY: gl.getUniformLocation(baseProgram, 'u_flipY')!
}

const brightPassUniforms = {
  texture: gl.getUniformLocation(brightPassProgram, 'u_texture')!,
  threshold: gl.getUniformLocation(brightPassProgram, 'u_threshold')!,
  flipY: gl.getUniformLocation(brightPassProgram, 'u_flipY')!
}

const blurUniforms = {
  texture: gl.getUniformLocation(blurProgram, 'u_texture')!,
  direction: gl.getUniformLocation(blurProgram, 'u_direction')!,
  resolution: gl.getUniformLocation(blurProgram, 'u_resolution')!,
  flipY: gl.getUniformLocation(blurProgram, 'u_flipY')!
}

const combineUniforms = {
  original: gl.getUniformLocation(combineProgram, 'u_original')!,
  bloom1: gl.getUniformLocation(combineProgram, 'u_bloom1')!,
  bloom2: gl.getUniformLocation(combineProgram, 'u_bloom2')!,
  bloom3: gl.getUniformLocation(combineProgram, 'u_bloom3')!,
  bloomIntensity: gl.getUniformLocation(combineProgram, 'u_bloomIntensity')!,
  flipY: gl.getUniformLocation(combineProgram, 'u_flipY')!
}

const positionAttributeLocation = gl.getAttribLocation(baseProgram, 'a_position')
const texCoordAttributeLocation = gl.getAttribLocation(baseProgram, 'a_texCoord')

// Create shared geometry buffers
const positionBuffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
const positions = [
  -1, -1,
  1, -1,
  -1, 1,
  -1, 1,
  1, -1,
  1, 1
]
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW)

const texCoordBuffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
const texCoords = [
  0, 1,
  1, 1,
  0, 0,
  0, 0,
  1, 1,
  1, 0
]
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW)

// Bloom configuration
const bloomConfig = {
  threshold: 0.8,
  intensity: 1.5,
  scales: [1.0, 0.5, 0.25, 0.125] // Different blur scales
}

// WebGL resources for bloom pipeline
let bloomResources: {
  originalTexture: WebGLTexture
  brightTexture: WebGLTexture
  brightFramebuffer: WebGLFramebuffer
  blurTextures: WebGLTexture[]
  blurFramebuffers: WebGLFramebuffer[]
  tempTextures: WebGLTexture[]
  tempFramebuffers: WebGLFramebuffer[]
  width: number
  height: number
} | null = null

function setupBloomResources(width: number, height: number) {
  if (bloomResources && bloomResources.width === width && bloomResources.height === height) {
    return bloomResources
  }

  // Clean up existing resources
  if (bloomResources) {
    gl.deleteTexture(bloomResources.originalTexture)
    gl.deleteTexture(bloomResources.brightTexture)
    gl.deleteFramebuffer(bloomResources.brightFramebuffer)
    bloomResources.blurTextures.forEach(tex => gl.deleteTexture(tex))
    bloomResources.blurFramebuffers.forEach(fb => gl.deleteFramebuffer(fb))
    bloomResources.tempTextures.forEach(tex => gl.deleteTexture(tex))
    bloomResources.tempFramebuffers.forEach(fb => gl.deleteFramebuffer(fb))
  }

  // Create original texture (for the terminal content)
  const originalTexture = createTexture(gl, width, height)

  // Create bright pass texture and framebuffer
  const brightTexture = createTexture(gl, width, height)
  const brightFramebuffer = createFramebuffer(gl, brightTexture)

  // Create blur textures at different scales
  const blurTextures: WebGLTexture[] = []
  const blurFramebuffers: WebGLFramebuffer[] = []
  const tempTextures: WebGLTexture[] = []
  const tempFramebuffers: WebGLFramebuffer[] = []

  for (let i = 1; i < bloomConfig.scales.length; i++) {
    const scale = bloomConfig.scales[i]
    const scaledWidth = Math.max(1, Math.floor(width * scale))
    const scaledHeight = Math.max(1, Math.floor(height * scale))

    // Create texture and framebuffer for this scale
    const blurTexture = createTexture(gl, scaledWidth, scaledHeight)
    const blurFramebuffer = createFramebuffer(gl, blurTexture)
    blurTextures.push(blurTexture)
    blurFramebuffers.push(blurFramebuffer)

    // Create temporary texture for separable blur
    const tempTexture = createTexture(gl, scaledWidth, scaledHeight)
    const tempFramebuffer = createFramebuffer(gl, tempTexture)
    tempTextures.push(tempTexture)
    tempFramebuffers.push(tempFramebuffer)
  }

  bloomResources = {
    originalTexture,
    brightTexture,
    brightFramebuffer,
    blurTextures,
    blurFramebuffers,
    tempTextures,
    tempFramebuffers,
    width,
    height
  }

  return bloomResources
}

function setupVertexAttributes() {
  // Set up position attribute
  gl.enableVertexAttribArray(positionAttributeLocation)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0)

  // Set up texture coordinate attribute
  gl.enableVertexAttribArray(texCoordAttributeLocation)
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
  gl.vertexAttribPointer(texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0)
}

function renderFullscreenQuad() {
  setupVertexAttributes()
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

function draw() {
  // Render terminal to offscreen canvas
  renderTerminalToOffscreen(
    offscreenCanvas,
    offscreenCtx,
    webglCanvas
  )

  // Set up WebGL canvas size
  const canvasRect = webglCanvas.getBoundingClientRect()
  const displayWidth = Math.floor(canvasRect.width * window.devicePixelRatio)
  const displayHeight = Math.floor(canvasRect.height * window.devicePixelRatio)

  webglCanvas.width = displayWidth
  webglCanvas.height = displayHeight

  if (!gl) {
    throw new Error('WebGL context not available')
  }

  // Setup bloom resources
  const resources = setupBloomResources(displayWidth, displayHeight)

  // Step 1: Upload terminal content to original texture
  gl.bindTexture(gl.TEXTURE_2D, resources.originalTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas)

  // Step 2: Bright pass - extract bright pixels
  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.brightFramebuffer)
  gl.viewport(0, 0, displayWidth, displayHeight)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.useProgram(brightPassProgram)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, resources.originalTexture)
  gl.uniform1i(brightPassUniforms.texture, 0)
  gl.uniform1f(brightPassUniforms.threshold, bloomConfig.threshold)
  gl.uniform1i(brightPassUniforms.flipY, 1)
  renderFullscreenQuad()

  // Step 3: Multi-scale blur passes
  let currentTexture = resources.brightTexture

  for (let i = 0; i < resources.blurTextures.length; i++) {
    const scale = bloomConfig.scales[i + 1]
    const scaledWidth = Math.max(1, Math.floor(displayWidth * scale))
    const scaledHeight = Math.max(1, Math.floor(displayHeight * scale))

    // Horizontal blur pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.tempFramebuffers[i])
    gl.viewport(0, 0, scaledWidth, scaledHeight)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(blurProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, currentTexture)
    gl.uniform1i(blurUniforms.texture, 0)
    gl.uniform2f(blurUniforms.direction, 1.0, 0.0) // Horizontal
    gl.uniform2f(blurUniforms.resolution, scaledWidth, scaledHeight)
    gl.uniform1i(blurUniforms.flipY, 1)
    renderFullscreenQuad()

    // Vertical blur pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.blurFramebuffers[i])
    gl.viewport(0, 0, scaledWidth, scaledHeight)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, resources.tempTextures[i])
    gl.uniform1i(blurUniforms.texture, 0)
    gl.uniform2f(blurUniforms.direction, 0.0, 1.0) // Vertical
    gl.uniform2f(blurUniforms.resolution, scaledWidth, scaledHeight)
    gl.uniform1i(blurUniforms.flipY, 1)
    renderFullscreenQuad()

    // Use this blur result as input for next iteration (if any)
    currentTexture = resources.blurTextures[i]
  }

  // Step 4: Final combine pass - render to screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, displayWidth, displayHeight)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.useProgram(combineProgram)

  // Bind original texture
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, resources.originalTexture)
  gl.uniform1i(combineUniforms.original, 0)

  // Bind bloom textures
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, resources.blurTextures[0] || resources.brightTexture)
  gl.uniform1i(combineUniforms.bloom1, 1)

  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, resources.blurTextures[1] || resources.brightTexture)
  gl.uniform1i(combineUniforms.bloom2, 2)

  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, resources.blurTextures[2] || resources.brightTexture)
  gl.uniform1i(combineUniforms.bloom3, 3)

  gl.uniform1f(combineUniforms.bloomIntensity, bloomConfig.intensity)
  gl.uniform1i(combineUniforms.flipY, 0)
  renderFullscreenQuad()

  requestAnimationFrame(draw)
}

// Handle resize
function handleResize() {
  const canvasRect = webglCanvas.getBoundingClientRect()
  webglCanvas.style.width = `${canvasRect.width}px`
  webglCanvas.style.height = `${canvasRect.height}px`
}

window.addEventListener('resize', handleResize)
handleResize()

// Add bloom controls (optional - for tweaking)
const controls = document.createElement('div')
controls.style.position = 'fixed'
controls.style.top = '10px'
controls.style.right = '10px'
controls.style.background = 'rgba(0,0,0,0.8)'
controls.style.color = 'white'
controls.style.padding = '10px'
controls.style.borderRadius = '5px'
controls.style.fontFamily = 'monospace'
controls.style.fontSize = '12px'
controls.innerHTML = `
  <div>Bloom Controls:</div>
  <div>
    <label>Threshold: </label>
    <input type="range" id="threshold" min="0" max="1" step="0.01" value="${bloomConfig.threshold}">
    <span id="thresholdValue">${bloomConfig.threshold}</span>
  </div>
  <div>
    <label>Intensity: </label>
    <input type="range" id="intensity" min="0" max="5" step="0.1" value="${bloomConfig.intensity}">
    <span id="intensityValue">${bloomConfig.intensity}</span>
  </div>
`
document.body.appendChild(controls)

// Bloom control event listeners
const thresholdSlider = document.getElementById('threshold') as HTMLInputElement
const thresholdValue = document.getElementById('thresholdValue')!
const intensitySlider = document.getElementById('intensity') as HTMLInputElement
const intensityValue = document.getElementById('intensityValue')!

thresholdSlider.addEventListener('input', (e) => {
  bloomConfig.threshold = parseFloat((e.target as HTMLInputElement).value)
  thresholdValue.textContent = bloomConfig.threshold.toString()
})

intensitySlider.addEventListener('input', (e) => {
  bloomConfig.intensity = parseFloat((e.target as HTMLInputElement).value)
  intensityValue.textContent = bloomConfig.intensity.toString()
})

// Start the render loop
draw()
