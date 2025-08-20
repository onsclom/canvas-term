import './style.css'
import { renderTerminalToOffscreen, textHeight } from './terminal'

// Bloom configuration
const bloomConfig = {
  threshold: 0.9,
  intensity: .6,
  radius: 2.5,
  scales: [1.0, 0.8, 0.6, 0.5, 0.4] // More passes at higher resolutions
}

// Scanline configuration
const scanlineConfig = {
  intensity: 0.7,        // How strong the scanlines are (0-1)
  frequency: 1.0,         // Scanline frequency multiplier
  speed: 2.0,             // Animation speed
  offset: 0.5             // Phase offset
}

// White noise configuration
const noiseConfig = {
  intensity: 0.09,        // How strong the noise is (0-1)
}

// Curved screen configuration
const curveConfig = {
  curvature: 0.075,         // How curved the screen is (0-1, 0 = flat)
  vignetteStrength: 0.1,   // Darkness at edges (0-1)
  vignetteSize: 0.8,       // Size of vignette effect (0-1)
  screenScale: 0.95        // Scale factor for the curved content (0-1)
}

const THEMES = [
  [0.0, 1.0, 0.0],    // Green
  [1.0, 0.75, 0.0],   // Amber
  [0.3, 0.7, 1.0],    // Blue
  [1.0, 0.2, 0.2],    // Red
  [1.0, 1.0, 1.0],    // White
  [0.0, 1.0, 1.0]     // Cyan
]
let currentThemeIndex = 0
export function nextTheme() {
  currentThemeIndex = (currentThemeIndex + 1) % THEMES.length
}

function assert(condition: boolean): asserts condition {
}

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
uniform float u_radius;

void main() {
  vec2 texelSize = 1.0 / u_resolution;
  vec4 color = vec4(0.0);

  // Gaussian weights for 21-tap blur (much larger radius)
  float weights[11];
  weights[0] = 0.05299;
  weights[1] = 0.05268;
  weights[2] = 0.05175;
  weights[3] = 0.05020;
  weights[4] = 0.04810;
  weights[5] = 0.04551;
  weights[6] = 0.04252;
  weights[7] = 0.03924;
  weights[8] = 0.03576;
  weights[9] = 0.03220;
  weights[10] = 0.02867;

  // Sample center
  color += texture2D(u_texture, v_texCoord) * weights[0];

  // Sample both directions with increased radius
  for(int i = 1; i < 11; i++) {
    vec2 offset = u_direction * texelSize * float(i) * u_radius;
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
uniform vec3 u_tintColor;
uniform float u_scanlineIntensity;
uniform float u_scanlineFrequency;
uniform float u_noiseIntensity;
uniform float u_noisePixelSize;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_curvature;
uniform float u_vignetteStrength;
uniform float u_vignetteSize;
uniform float u_screenScale;

// Pseudo-random function for noise
float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

// Apply barrel distortion for curved screen effect
vec2 curveScreen(vec2 uv) {
  // Center the coordinates
  uv = uv * 2.0 - 1.0;

  // Apply barrel distortion
  float r2 = dot(uv, uv);
  float distortion = 1.0 + u_curvature * r2;
  uv *= distortion;

  // Scale and recenter
  uv = (uv * u_screenScale + 1.0) * 0.5;

  return uv;
}

void main() {
  // Apply curve distortion to texture coordinates
  vec2 curvedCoord = curveScreen(v_texCoord);

  // Check if we're outside the curved screen bounds
  if (curvedCoord.x < 0.0 || curvedCoord.x > 1.0 || curvedCoord.y < 0.0 || curvedCoord.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec4 original = texture2D(u_original, curvedCoord);
  vec4 bloom1 = texture2D(u_bloom1, curvedCoord);
  vec4 bloom2 = texture2D(u_bloom2, curvedCoord);
  vec4 bloom3 = texture2D(u_bloom3, curvedCoord);

  // Apply tint to original (multiply white text by tint color)
  original.rgb *= u_tintColor;

  // Apply tint to bloom as well
  bloom1.rgb *= u_tintColor;
  bloom2.rgb *= u_tintColor;
  bloom3.rgb *= u_tintColor;

  vec4 bloom = (bloom1 + bloom2 + bloom3) * u_bloomIntensity;
  vec4 finalColor = original + bloom;

  // Apply white noise before scanline effect
  vec2 noiseCoord = floor(curvedCoord * u_resolution / u_noisePixelSize) * u_noisePixelSize / u_resolution;
  float noise = random(noiseCoord + u_time * 0.1) * 2.0 - 1.0;
  finalColor.rgb += noise * u_noiseIntensity;

  // Apply scanline effect using curved coordinates
  float scanlineY = curvedCoord.y * u_resolution.y * u_scanlineFrequency;
  float scanline = sin(scanlineY + u_time) * 0.5 + 0.5;
  float scanlineFactor = 1.0 - (scanline * u_scanlineIntensity);

  // Apply subtle horizontal fade for more realistic CRT effect
  float horizontalFade = sin(curvedCoord.y * 3.14159) * 0.1 + 0.9;
  scanlineFactor *= horizontalFade;

  finalColor.rgb *= scanlineFactor;

  // Apply vignette effect
  vec2 vignetteCoord = v_texCoord * 2.0 - 1.0;
  float vignette = 1.0 - smoothstep(u_vignetteSize, 1.0, length(vignetteCoord));
  vignette = mix(1.0 - u_vignetteStrength, 1.0, vignette);
  finalColor.rgb *= vignette;

  gl_FragColor = finalColor;
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

const brightPassUniforms = {
  texture: gl.getUniformLocation(brightPassProgram, 'u_texture')!,
  threshold: gl.getUniformLocation(brightPassProgram, 'u_threshold')!,
  flipY: gl.getUniformLocation(brightPassProgram, 'u_flipY')!
}

const blurUniforms = {
  texture: gl.getUniformLocation(blurProgram, 'u_texture')!,
  direction: gl.getUniformLocation(blurProgram, 'u_direction')!,
  resolution: gl.getUniformLocation(blurProgram, 'u_resolution')!,
  radius: gl.getUniformLocation(blurProgram, 'u_radius')!,
  flipY: gl.getUniformLocation(blurProgram, 'u_flipY')!
}

const combineUniforms = {
  original: gl.getUniformLocation(combineProgram, 'u_original')!,
  bloom1: gl.getUniformLocation(combineProgram, 'u_bloom1')!,
  bloom2: gl.getUniformLocation(combineProgram, 'u_bloom2')!,
  bloom3: gl.getUniformLocation(combineProgram, 'u_bloom3')!,
  bloomIntensity: gl.getUniformLocation(combineProgram, 'u_bloomIntensity')!,
  tintColor: gl.getUniformLocation(combineProgram, 'u_tintColor')!,
  scanlineIntensity: gl.getUniformLocation(combineProgram, 'u_scanlineIntensity')!,
  scanlineFrequency: gl.getUniformLocation(combineProgram, 'u_scanlineFrequency')!,
  noiseIntensity: gl.getUniformLocation(combineProgram, 'u_noiseIntensity')!,
  noisePixelSize: gl.getUniformLocation(combineProgram, 'u_noisePixelSize')!,
  time: gl.getUniformLocation(combineProgram, 'u_time')!,
  resolution: gl.getUniformLocation(combineProgram, 'u_resolution')!,
  curvature: gl.getUniformLocation(combineProgram, 'u_curvature')!,
  vignetteStrength: gl.getUniformLocation(combineProgram, 'u_vignetteStrength')!,
  vignetteSize: gl.getUniformLocation(combineProgram, 'u_vignetteSize')!,
  screenScale: gl.getUniformLocation(combineProgram, 'u_screenScale')!
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
  assert(gl !== null)
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
  assert(gl !== null)
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
  assert(gl !== null)
  setupVertexAttributes()
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

function draw() {
  // Set up WebGL canvas size
  const canvasRect = webglCanvas.getBoundingClientRect()
  const displayWidth = Math.floor(canvasRect.width * window.devicePixelRatio)
  const displayHeight = Math.floor(canvasRect.height * window.devicePixelRatio)
  webglCanvas.width = displayWidth
  webglCanvas.height = displayHeight

  // Render terminal to offscreen canvas
  renderTerminalToOffscreen(
    offscreenCanvas,
    offscreenCtx,
    webglCanvas
  )


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

    const radiusScale = Math.max(0.3, scale)
    gl.useProgram(blurProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, currentTexture)
    gl.uniform1i(blurUniforms.texture, 0)
    gl.uniform2f(blurUniforms.direction, 1.0, 0.0) // Horizontal
    gl.uniform2f(blurUniforms.resolution, scaledWidth, scaledHeight)
    gl.uniform1f(blurUniforms.radius, bloomConfig.radius * radiusScale)
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
    gl.uniform1f(blurUniforms.radius, bloomConfig.radius * radiusScale)
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
  const TERMINAL_TINT_COLOR = THEMES[currentThemeIndex % THEMES.length]
  gl.uniform3f(combineUniforms.tintColor, TERMINAL_TINT_COLOR[0], TERMINAL_TINT_COLOR[1], TERMINAL_TINT_COLOR[2])
  gl.uniform1f(combineUniforms.scanlineIntensity, scanlineConfig.intensity)
  gl.uniform1f(combineUniforms.scanlineFrequency, scanlineConfig.frequency / (textHeight * devicePixelRatio / (48 * 2)))
  gl.uniform1f(combineUniforms.noiseIntensity, noiseConfig.intensity)
  gl.uniform1f(combineUniforms.noisePixelSize, 6 * (textHeight * devicePixelRatio / (48 * 2)))
  gl.uniform1f(combineUniforms.time, performance.now() * 0.001 * scanlineConfig.speed + scanlineConfig.offset)
  gl.uniform2f(combineUniforms.resolution, displayWidth, displayHeight)
  gl.uniform1f(combineUniforms.curvature, curveConfig.curvature)
  gl.uniform1f(combineUniforms.vignetteStrength, curveConfig.vignetteStrength)
  gl.uniform1f(combineUniforms.vignetteSize, curveConfig.vignetteSize)
  gl.uniform1f(combineUniforms.screenScale, curveConfig.screenScale)
  renderFullscreenQuad()

  requestAnimationFrame(draw)
}

draw()
