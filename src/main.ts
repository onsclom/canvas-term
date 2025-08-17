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

// Vertex shader source
const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`

// Fragment shader source with ghostty glitch effect
const fragmentShaderSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;

// modified version of https://www.shadertoy.com/view/wld3WN
// amount of seconds for which the glitch loop occurs
#define DURATION 10.
// percentage of the duration for which the glitch is triggered
#define AMT .1

#define SS(a, b, x) (smoothstep(a, b, x) * smoothstep(b, a, x))

// Hash function compatible with WebGL 1.0
vec3 hash33(vec3 p)
{
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}

// Gradient noise by iq
float gnoise(vec3 x)
{
    // grid
    vec3 p = floor(x);
    vec3 w = fract(x);

    // quintic interpolant
    vec3 u = w * w * w * (w * (w * 6. - 15.) + 10.);

    // gradients
    vec3 ga = hash33(p + vec3(0., 0., 0.));
    vec3 gb = hash33(p + vec3(1., 0., 0.));
    vec3 gc = hash33(p + vec3(0., 1., 0.));
    vec3 gd = hash33(p + vec3(1., 1., 0.));
    vec3 ge = hash33(p + vec3(0., 0., 1.));
    vec3 gf = hash33(p + vec3(1., 0., 1.));
    vec3 gg = hash33(p + vec3(0., 1., 1.));
    vec3 gh = hash33(p + vec3(1., 1., 1.));

    // projections
    float va = dot(ga, w - vec3(0., 0., 0.));
    float vb = dot(gb, w - vec3(1., 0., 0.));
    float vc = dot(gc, w - vec3(0., 1., 0.));
    float vd = dot(gd, w - vec3(1., 1., 0.));
    float ve = dot(ge, w - vec3(0., 0., 1.));
    float vf = dot(gf, w - vec3(1., 0., 1.));
    float vg = dot(gg, w - vec3(0., 1., 1.));
    float vh = dot(gh, w - vec3(1., 1., 1.));

    // interpolation
    float gNoise = va + u.x * (vb - va) +
           		u.y * (vc - va) +
           		u.z * (ve - va) +
           		u.x * u.y * (va - vb - vc + vd) +
           		u.y * u.z * (va - vc - ve + vg) +
           		u.z * u.x * (va - vb - ve + vf) +
           		u.x * u.y * u.z * (-va + vb + vc - vd + ve - vf - vg + vh);

    return 2. * gNoise;
}

// gradient noise in range [0, 1]
float gnoise01(vec3 x)
{
	return .5 + .5 * gnoise(x);
}

// warp uvs for the crt effect
vec2 crt(vec2 uv)
{
    float tht  = atan(uv.y, uv.x);
    float r = length(uv);
    // curve without distorting the center
    r /= (1. - .1 * r * r);
    uv.x = r * cos(tht);
    uv.y = r * sin(tht);
    return .5 * (uv + 1.);
}

void main()
{
    vec2 fragCoord = v_texCoord * u_resolution;
    vec2 uv = fragCoord / u_resolution;
    float t = u_time;

    // smoothed interval for which the glitch gets triggered
    float glitchAmount = SS(DURATION * .001, DURATION * AMT, mod(t, DURATION));
  	float displayNoise = 0.;
    vec3 col = vec3(0.);
    vec2 eps = vec2(5. / u_resolution.x, 0.);
    vec2 st = vec2(0.);

    // analog distortion
    float y = uv.y * u_resolution.y;
    float distortion = gnoise(vec3(0., y * .01, t * 500.)) * (glitchAmount * 4. + .1);
    distortion *= gnoise(vec3(0., y * .02, t * 250.)) * (glitchAmount * 2. + .025);

    ++displayNoise;
    distortion += smoothstep(.999, 1., sin((uv.y + t * 1.6) * 2.)) * .02;
    distortion -= smoothstep(.999, 1., sin((uv.y + t) * 2.)) * .02;
    st = uv + vec2(distortion, 0.);
    // chromatic aberration
    col.r += texture2D(u_texture, st + eps + distortion).r;
    col.g += texture2D(u_texture, st).g;
    col.b += texture2D(u_texture, st - eps - distortion).b;

    // bloom/glow effect with fixed radial sampling pattern
    vec3 bloom = vec3(0.0);
    float bloomRadius = 3.0 / u_resolution.x;

    // Define fixed radial offsets for smooth circular bloom
    vec2 offsets[13];
    offsets[0] = vec2(0.0, 0.0); // center
    offsets[1] = vec2(1.0, 0.0); offsets[2] = vec2(0.707, 0.707); offsets[3] = vec2(0.0, 1.0); offsets[4] = vec2(-0.707, 0.707);
    offsets[5] = vec2(-1.0, 0.0); offsets[6] = vec2(-0.707, -0.707); offsets[7] = vec2(0.0, -1.0); offsets[8] = vec2(0.707, -0.707);
    offsets[9] = vec2(1.5, 0.0); offsets[10] = vec2(0.0, 1.5); offsets[11] = vec2(-1.5, 0.0); offsets[12] = vec2(0.0, -1.5);

    for(int i = 0; i < 13; i++) {
        vec2 offset = offsets[i] * bloomRadius;
        float dist = length(offset);
        float weight = exp(-dist * dist * 3.0);
        vec3 sample = texture2D(u_texture, st + offset).rgb;

        // Enhance green channel for terminal glow
        sample.g *= 1.3;
        bloom += sample * weight;
    }

    bloom *= 0.15; // Adjust bloom intensity

    // Add bloom to original color
    col += bloom;

    // white noise + scanlines
    displayNoise = 0.2 * clamp(displayNoise, 0., 1.);
    col += (.15 + .65 * glitchAmount) * (hash33(vec3(fragCoord, mod(t * 60., 1000.))).r) * displayNoise;
    col -= (.25 + .75 * glitchAmount) * (sin(4. * t + uv.y * u_resolution.y * 1.75)) * displayNoise;
    gl_FragColor = vec4(col, 1.0);
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

// Set up WebGL
const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)
const program = createProgram(gl, vertexShader, fragmentShader)

// Get attribute and uniform locations
const positionAttributeLocation = gl.getAttribLocation(program, 'a_position')
const texCoordAttributeLocation = gl.getAttribLocation(program, 'a_texCoord')
const textureUniformLocation = gl.getUniformLocation(program, 'u_texture')
const timeUniformLocation = gl.getUniformLocation(program, 'u_time')
const resolutionUniformLocation = gl.getUniformLocation(program, 'u_resolution')

// Create buffers
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

// Create texture
const texture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, texture)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)


function draw() {
  // Render terminal to offscreen canvas
  renderTerminalToOffscreen(
    offscreenCanvas,
    offscreenCtx,
    webglCanvas
  )

  // Set up WebGL canvas size
  const canvasRect = webglCanvas.getBoundingClientRect()
  webglCanvas.width = canvasRect.width * window.devicePixelRatio
  webglCanvas.height = canvasRect.height * window.devicePixelRatio

  if (!gl) {
    throw new Error('WebGL context not available')
  }

  gl.viewport(0, 0, webglCanvas.width, webglCanvas.height)

  // Update texture with offscreen canvas
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas)

  // Clear and render
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.useProgram(program)

  // Set up position attribute
  gl.enableVertexAttribArray(positionAttributeLocation)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0)

  // Set up texture coordinate attribute
  gl.enableVertexAttribArray(texCoordAttributeLocation)
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
  gl.vertexAttribPointer(texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0)

  // Set uniforms
  gl.uniform1i(textureUniformLocation, 0)
  gl.uniform1f(timeUniformLocation, performance.now() * 0.001)
  gl.uniform2f(resolutionUniformLocation, webglCanvas.width, webglCanvas.height)

  // Draw
  gl.drawArrays(gl.TRIANGLES, 0, 6)

  requestAnimationFrame(draw)
}

draw();
