// UI 統合用ファサード。画面側との契約はこのクラス。React 非依存。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Difficulty, SceneSpec } from './generator.ts';
import { generateSceneSpec, buildScene } from './generator.ts';
import type { LightPreset, ShadingSteps } from './shading.ts';
import { setupLights, applyShading } from './shading.ts';
import type { OutlineParams } from './outline.ts';
import { OutlineRenderer } from './outline.ts';
import type { GroundTruth } from './groundTruth.ts';
import { captureGroundTruth } from './groundTruth.ts';
import { createRng } from './random.ts';

export type RenderMode = 'line' | 'shaded' | 'wireframe';

export class Scene3DView {
  private canvas: HTMLCanvasElement;
  private width: number;
  private height: number;
  private renderer: THREE.WebGLRenderer;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private meshes: THREE.Mesh[] = [];
  private spec: SceneSpec | null = null;

  private outline: OutlineRenderer | null = null;
  private controls: OrbitControls | null = null;

  private mode: RenderMode = 'shaded';
  private lightPreset: LightPreset = 'threePoint';
  private shadingSteps: ShadingSteps = 3;
  private outlineParams: Partial<OutlineParams> = {};

  // ワイヤーフレーム表示用の透視エッジ線（隠面も見える）
  private wireGroup: THREE.Group | null = null;

  private rafId = 0;

  constructor(canvas: HTMLCanvasElement, opts: { width: number; height: number }) {
    this.canvas = canvas;
    this.width = opts.width;
    this.height = opts.height;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xffffff, 1);

    this.startLoop();
  }

  /** seed/difficulty からシーンを構築。返り値の SceneSpec を UI 側で保持してよい */
  loadScene(seed: number, difficulty: Difficulty): SceneSpec {
    this.disposeScene();

    const spec = generateSceneSpec(seed, difficulty);
    const { scene, camera, meshes } = buildScene(spec);
    camera.aspect = this.width / this.height;
    camera.updateProjectionMatrix();

    this.spec = spec;
    this.scene = scene;
    this.camera = camera;
    this.meshes = meshes;

    // ライト（key1 はシード由来で方位を僅かに乱数化）
    const rng = createRng(spec.seed ^ 0x9e3779b9);
    setupLights(scene, this.lightPreset, rng);
    applyShading(meshes, this.shadingSteps);

    // アウトライン
    this.outline = new OutlineRenderer(this.renderer, scene, camera, this.width, this.height);
    if (Object.keys(this.outlineParams).length > 0) this.outline.setParams(this.outlineParams);

    // ワイヤーフレーム用グループを事前生成
    this.buildWireframe();

    // OrbitControls があれば対象カメラに張り替え
    if (this.controls) {
      this.controls.dispose();
      this.controls = new OrbitControls(camera, this.canvas);
      this.controls.target.set(spec.camera.target[0], spec.camera.target[1], spec.camera.target[2]);
      this.controls.update();
    }

    return spec;
  }

  setRenderMode(mode: RenderMode): void {
    this.mode = mode;
    this.applyModeVisibility();
  }

  setOutlineParams(p: Partial<OutlineParams>): void {
    this.outlineParams = { ...this.outlineParams, ...p };
    this.outline?.setParams(p);
  }

  setLightPreset(p: LightPreset): void {
    this.lightPreset = p;
    if (this.scene) {
      const rng = createRng((this.spec?.seed ?? 0) ^ 0x9e3779b9);
      setupLights(this.scene, p, rng);
    }
  }

  setShadingSteps(s: ShadingSteps): void {
    this.shadingSteps = s;
    if (this.meshes.length) applyShading(this.meshes, s);
  }

  /** OrbitControls 有効化（描く前の回転確認用） */
  enableOrbit(): void {
    if (!this.camera) return;
    if (this.controls) return;
    this.controls = new OrbitControls(this.camera, this.canvas);
    if (this.spec) {
      this.controls.target.set(
        this.spec.camera.target[0],
        this.spec.camera.target[1],
        this.spec.camera.target[2],
      );
    }
    this.controls.update();
  }

  /** ビューを spec のカメラへ戻して固定（orbit 中の変更を破棄）。groundTruth は固定ビューで取得 */
  lockView(): void {
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    if (this.camera && this.spec) {
      this.camera.fov = this.spec.camera.fov;
      this.camera.position.set(
        this.spec.camera.position[0],
        this.spec.camera.position[1],
        this.spec.camera.position[2],
      );
      this.camera.lookAt(
        this.spec.camera.target[0],
        this.spec.camera.target[1],
        this.spec.camera.target[2],
      );
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
  }

  /** 固定ビューで正解データを取得（呼び出し前に lockView 推奨） */
  captureGroundTruth(): GroundTruth {
    if (!this.renderer || !this.scene || !this.camera || !this.spec || !this.outline) {
      throw new Error('Scene3DView: scene が未ロードです');
    }
    return captureGroundTruth(this.spec, this.outline);
  }

  get currentSpec(): SceneSpec | null {
    return this.spec;
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.disposeScene();
    this.renderer.dispose();
  }

  // ---- 内部処理 ----

  private startLoop(): void {
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.controls?.update();
      this.renderFrame();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private renderFrame(): void {
    if (!this.scene || !this.camera) return;
    if (this.mode === 'line' && this.outline) {
      this.outline.renderToScreen();
    } else {
      // shaded / wireframe は通常レンダリング（可視性は applyModeVisibility で制御済み）
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** EdgesGeometry による透視ワイヤーフレーム（隠面も見える）を構築 */
  private buildWireframe(): void {
    if (!this.scene) return;
    if (this.wireGroup) {
      this.scene.remove(this.wireGroup);
      this.wireGroup.traverse((o) => {
        const l = o as THREE.LineSegments;
        l.geometry?.dispose();
      });
    }
    const group = new THREE.Group();
    group.name = 'al_wireframe';
    const lineMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    for (const mesh of this.meshes) {
      const edges = new THREE.EdgesGeometry(mesh.geometry, 20);
      const seg = new THREE.LineSegments(edges, lineMat);
      seg.position.copy(mesh.position);
      seg.rotation.copy(mesh.rotation);
      seg.scale.copy(mesh.scale);
      group.add(seg);
    }
    group.visible = false;
    this.scene.add(group);
    this.wireGroup = group;
  }

  /** モードに応じてメッシュ/ワイヤーの可視性を切り替える */
  private applyModeVisibility(): void {
    const showShaded = this.mode === 'shaded';
    for (const m of this.meshes) m.visible = showShaded || this.mode === 'line';
    if (this.wireGroup) this.wireGroup.visible = this.mode === 'wireframe';
    // wireframe ではソリッドを隠す（透視のため床も非表示）
    if (this.mode === 'wireframe') {
      for (const m of this.meshes) m.visible = false;
      const ground = this.scene?.getObjectByName('ground');
      if (ground) ground.visible = false;
    } else {
      const ground = this.scene?.getObjectByName('ground');
      if (ground) ground.visible = true;
    }
  }

  private disposeScene(): void {
    this.outline?.dispose();
    this.outline = null;
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    if (this.scene) {
      this.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
    }
    this.scene = null;
    this.camera = null;
    this.meshes = [];
    this.wireGroup = null;
    this.spec = null;
  }
}
