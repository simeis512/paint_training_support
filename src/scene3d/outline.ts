// 深度+法線バッファの Sobel ポストプロセスによる線画。
// 方式: MRT(1パス) で「視空間法線」と「線形化深度」を2つのカラーアタッチメントへ描画し、
// フルスクリーンクアッドの Sobel シェーダで深度勾配・法線勾配の不連続を線として抽出する。
// 輪郭(シルエット)+稜線(法線不連続)+貫入交差線(深度不連続)をカバー。
import * as THREE from 'three';

export type OutlineParams = {
  depthThreshold: number; // 深度勾配の閾値（線形化深度 0..1 基準）
  normalThreshold: number; // 法線勾配の閾値（0..1、1=90°相当）
  thickness: number; // サンプリングオフセット倍率（1〜3程度）
};

// G-Buffer 書き込み用シェーダ: rt0=視空間法線(rgb), rt1=線形化深度(r)
const gBufferVert = /* glsl */ `
varying vec3 vViewNormal;
varying float vViewDepth; // 視空間でのカメラからの距離(正の値)
void main() {
  vViewNormal = normalize(normalMatrix * normal);
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -viewPos.z; // カメラ前方が -z
  gl_Position = projectionMatrix * viewPos;
}
`;

const gBufferFrag = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gNormal;
layout(location = 1) out vec4 gDepth;
varying vec3 vViewNormal;
varying float vViewDepth;
uniform float uNear;
uniform float uFar;
void main() {
  // 法線を 0..1 にパック
  gNormal = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);
  // 視空間距離を near..far で線形に 0..1 正規化（遠近での感度差を抑える）
  float d = clamp((vViewDepth - uNear) / (uFar - uNear), 0.0, 1.0);
  gDepth = vec4(d, d, d, 1.0);
}
`;

// Sobel 合成シェーダ: 法線/深度の勾配を計算し閾値超過を黒線に
const sobelVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const sobelFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uTexel;        // 1/width, 1/height
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uThickness;   // サンプリング距離倍率

// 3x3 Sobel の8近傍を取得するためのオフセット
void main() {
  vec2 o = uTexel * uThickness;

  // --- 深度の Sobel ---
  float d00 = texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r;
  float d10 = texture2D(tDepth, vUv + vec2( 0.0, -o.y)).r;
  float d20 = texture2D(tDepth, vUv + vec2( o.x, -o.y)).r;
  float d01 = texture2D(tDepth, vUv + vec2(-o.x,  0.0)).r;
  float d21 = texture2D(tDepth, vUv + vec2( o.x,  0.0)).r;
  float d02 = texture2D(tDepth, vUv + vec2(-o.x,  o.y)).r;
  float d12 = texture2D(tDepth, vUv + vec2( 0.0,  o.y)).r;
  float d22 = texture2D(tDepth, vUv + vec2( o.x,  o.y)).r;

  float gxD = (d20 + 2.0*d21 + d22) - (d00 + 2.0*d01 + d02);
  float gyD = (d02 + 2.0*d12 + d22) - (d00 + 2.0*d10 + d20);
  float depthEdge = length(vec2(gxD, gyD));

  // 適応閾値: 中心深度が遠いほど勾配が小さくなるため、深度に応じて閾値を緩める
  float dCenter = texture2D(tDepth, vUv).r;
  float adaptive = uDepthThreshold * (0.4 + 0.6 * dCenter);
  float depthLine = step(adaptive, depthEdge);

  // --- 法線の Sobel ---
  vec3 n00 = texture2D(tNormal, vUv + vec2(-o.x, -o.y)).rgb * 2.0 - 1.0;
  vec3 n10 = texture2D(tNormal, vUv + vec2( 0.0, -o.y)).rgb * 2.0 - 1.0;
  vec3 n20 = texture2D(tNormal, vUv + vec2( o.x, -o.y)).rgb * 2.0 - 1.0;
  vec3 n01 = texture2D(tNormal, vUv + vec2(-o.x,  0.0)).rgb * 2.0 - 1.0;
  vec3 n21 = texture2D(tNormal, vUv + vec2( o.x,  0.0)).rgb * 2.0 - 1.0;
  vec3 n02 = texture2D(tNormal, vUv + vec2(-o.x,  o.y)).rgb * 2.0 - 1.0;
  vec3 n12 = texture2D(tNormal, vUv + vec2( 0.0,  o.y)).rgb * 2.0 - 1.0;
  vec3 n22 = texture2D(tNormal, vUv + vec2( o.x,  o.y)).rgb * 2.0 - 1.0;

  vec3 gxN = (n20 + 2.0*n21 + n22) - (n00 + 2.0*n01 + n02);
  vec3 gyN = (n02 + 2.0*n12 + n22) - (n00 + 2.0*n10 + n20);
  float normalEdge = sqrt(dot(gxN, gxN) + dot(gyN, gyN));
  float normalLine = step(uNormalThreshold, normalEdge);

  // 深度線 or 法線線 で黒。背景(深度=1.0付近)同士の勾配は深度しきい値で自然に除外される
  float line = max(depthLine, normalLine);
  vec3 col = mix(vec3(1.0), vec3(0.0), line); // 白背景・黒線
  gl_FragColor = vec4(col, 1.0);
}
`;

export class OutlineRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private width: number;
  private height: number;

  private gBuffer: THREE.WebGLRenderTarget; // MRT: textures[0]=normal, [1]=depth
  private gMaterial: THREE.ShaderMaterial;
  private sobelMaterial: THREE.ShaderMaterial;
  private fsScene: THREE.Scene;
  private fsCamera: THREE.OrthographicCamera;
  private fsQuad: THREE.Mesh;
  private lineTarget: THREE.WebGLRenderTarget; // render() の描画先（白背景黒線）

  private params: OutlineParams = {
    depthThreshold: 0.06,
    normalThreshold: 0.6,
    thickness: 1.5,
  };

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.width = width;
    this.height = height;

    // MRT レンダーターゲット（2アタッチメント）。法線は精度確保のため Float、深度も Float。
    this.gBuffer = new THREE.WebGLRenderTarget(width, height, {
      count: 2,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.FloatType,
      depthBuffer: true,
    });
    this.gBuffer.textures[0].name = 'gNormal';
    this.gBuffer.textures[1].name = 'gDepth';

    this.gMaterial = new THREE.ShaderMaterial({
      vertexShader: gBufferVert,
      fragmentShader: gBufferFrag,
      glslVersion: THREE.GLSL3,
      uniforms: {
        uNear: { value: camera.near },
        uFar: { value: camera.far },
      },
    });

    this.sobelMaterial = new THREE.ShaderMaterial({
      vertexShader: sobelVert,
      fragmentShader: sobelFrag,
      uniforms: {
        tNormal: { value: this.gBuffer.textures[0] },
        tDepth: { value: this.gBuffer.textures[1] },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uDepthThreshold: { value: this.params.depthThreshold },
        uNormalThreshold: { value: this.params.normalThreshold },
        uThickness: { value: this.params.thickness },
      },
    });

    // フルスクリーンクアッド
    this.fsScene = new THREE.Scene();
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sobelMaterial);
    this.fsScene.add(this.fsQuad);

    this.lineTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
  }

  setParams(p: Partial<OutlineParams>): void {
    this.params = { ...this.params, ...p };
    this.sobelMaterial.uniforms.uDepthThreshold.value = this.params.depthThreshold;
    this.sobelMaterial.uniforms.uNormalThreshold.value = this.params.normalThreshold;
    this.sobelMaterial.uniforms.uThickness.value = this.params.thickness;
  }

  /** G-Buffer を描画（法線/深度を MRT へ） */
  private renderGBuffer(): void {
    this.gMaterial.uniforms.uNear.value = this.camera.near;
    this.gMaterial.uniforms.uFar.value = this.camera.far;
    const prevOverride = this.scene.overrideMaterial;
    const prevBg = this.scene.background;
    this.scene.overrideMaterial = this.gMaterial;
    this.scene.background = null; // 背景は描かない→深度=far(=1.0) のまま残す
    const prevTarget = this.renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.gBuffer);
    // 背景(描かれない領域)は白(1,1,1)でクリア: 深度=1.0(far)、法線は一様で勾配を生まない
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
  }

  /** 白背景に黒線で lineTarget（または screen）へ描画 */
  render(): void {
    this.renderGBuffer();
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.lineTarget);
    this.renderer.render(this.fsScene, this.fsCamera);
    this.renderer.setRenderTarget(prevTarget);
  }

  /** 画面（デフォルトフレームバッファ）へ直接線画を出す。view.ts のライン表示用 */
  renderToScreen(): void {
    this.renderGBuffer();
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fsScene, this.fsCamera);
    this.renderer.setRenderTarget(prevTarget);
  }

  /** 評価用エッジマップを読み出す（黒=線）。lineTarget をピクセル化 */
  renderToPixels(): { data: Uint8ClampedArray; width: number; height: number } {
    this.render();
    const buf = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.lineTarget, 0, 0, this.width, this.height, buf);
    // WebGL は左下原点。上下反転して画像座標(左上原点)に揃える
    const flipped = new Uint8ClampedArray(buf.length);
    const rowBytes = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const src = (this.height - 1 - y) * rowBytes;
      flipped.set(buf.subarray(src, src + rowBytes), y * rowBytes);
    }
    return { data: flipped, width: this.width, height: this.height };
  }

  /** 線形化深度バッファを読み出す（0..1, near=0/far=1/背景=1）。groundTruth 用 */
  readDepthPixels(): { data: Float32Array; width: number; height: number } {
    this.renderGBuffer();
    const buf = new Float32Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.gBuffer, 0, 0, this.width, this.height, buf, 1);
    // r チャンネルのみ抽出 + 上下反転
    const out = new Float32Array(this.width * this.height);
    for (let y = 0; y < this.height; y++) {
      const srcRow = (this.height - 1 - y) * this.width * 4;
      const dstRow = y * this.width;
      for (let x = 0; x < this.width; x++) {
        out[dstRow + x] = buf[srcRow + x * 4];
      }
    }
    return { data: out, width: this.width, height: this.height };
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.gBuffer.setSize(w, h);
    this.lineTarget.setSize(w, h);
    this.sobelMaterial.uniforms.uTexel.value.set(1 / w, 1 / h);
    // setSize 後はテクスチャ参照が維持される（同一インスタンス）
    this.sobelMaterial.uniforms.tNormal.value = this.gBuffer.textures[0];
    this.sobelMaterial.uniforms.tDepth.value = this.gBuffer.textures[1];
  }

  dispose(): void {
    this.gBuffer.dispose();
    this.lineTarget.dispose();
    this.gMaterial.dispose();
    this.sobelMaterial.dispose();
    this.fsQuad.geometry.dispose();
  }
}
