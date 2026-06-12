// シード付きシーン生成。同一シード＋難易度 → SceneSpec が完全一致（決定論的）。
import * as THREE from 'three';
import { createRng, rangeFloat, rangeInt, pick } from './random.ts';

// ①単体 ②複数 ③相互貫入（④頂点ノイズは P1。型は number 互換で拡張可能）
export type Difficulty = 1 | 2 | 3;

export type PrimitiveKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus';

export type SceneObject = {
  kind: PrimitiveKind;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

export type SceneSpec = {
  seed: number;
  difficulty: Difficulty;
  objects: SceneObject[];
  camera: { fov: number; position: [number, number, number]; target: [number, number, number] };
};

const KINDS: readonly PrimitiveKind[] = ['box', 'sphere', 'cylinder', 'cone', 'torus'];

// 各プリミティブの「単位ジオメトリ」の半径(xz)と高さ(y)。接地計算に使う。
// ジオメトリは buildScene 側で同じ寸法で生成する。
type Metrics = { halfHeight: number; radius: number };
function unitMetrics(kind: PrimitiveKind): Metrics {
  switch (kind) {
    case 'box':
      return { halfHeight: 0.5, radius: Math.SQRT1_2 }; // 1x1x1 の半対角
    case 'sphere':
      return { halfHeight: 0.5, radius: 0.5 };
    case 'cylinder':
      return { halfHeight: 0.5, radius: 0.5 };
    case 'cone':
      return { halfHeight: 0.5, radius: 0.5 };
    case 'torus':
      return { halfHeight: 0.3, radius: 0.65 }; // 主半径0.5+管半径0.15 程度
  }
}

/** 難易度ごとの個数を決定論的に決める */
function objectCount(rng: () => number, difficulty: Difficulty): number {
  if (difficulty === 1) return 1;
  if (difficulty === 2) return rangeInt(rng, 2, 5);
  return rangeInt(rng, 2, 4); // 相互貫入
}

/** 1オブジェクトを生成。base はスケール基準。接地のため y はスケール後に確定させる */
function makeObject(rng: () => number, difficulty: Difficulty, index: number): SceneObject {
  const kind = pick(rng, KINDS);
  // スケールは概ね等方。やや非等方も許容（決定論的）
  const s = rangeFloat(rng, 0.6, 1.3);
  const sx = s * rangeFloat(rng, 0.85, 1.15);
  const sy = s * rangeFloat(rng, 0.85, 1.15);
  const sz = s * rangeFloat(rng, 0.85, 1.15);

  // 回転: torus/box は全軸、回転体(sphere除く)は主に y。決定論的に全軸振る
  const rx = rangeFloat(rng, 0, Math.PI * 2);
  const ry = rangeFloat(rng, 0, Math.PI * 2);
  const rz = rangeFloat(rng, 0, Math.PI * 2);

  // 水平配置。難易度3は中心付近に密集させ相互貫入を誘発
  const spread = difficulty === 3 ? 0.35 : 1.4;
  const px = rangeFloat(rng, -spread, spread) + (difficulty === 3 ? 0 : index * 0.0);
  const pz = rangeFloat(rng, -spread, spread);

  const m = unitMetrics(kind);
  // 接地: スケール後の最下端が床(y=0)に来るよう中心 y を設定。
  // 回転で厳密な最下端は変わるが、デッサン用途では近似接地で十分。
  let py = m.halfHeight * sy;
  if (difficulty === 3) {
    // 相互貫入: 一部を意図的に床へめり込ませず、他オブジェクトへ食い込ませるため高さを乱す
    py += rangeFloat(rng, -0.25, 0.5) * m.halfHeight * sy;
  }

  return {
    kind,
    position: [px, py, pz],
    rotation: [rx, ry, rz],
    scale: [sx, sy, sz],
  };
}

/** オブジェクト群のバウンディングスフィア（中心・半径）を概算 */
function boundsOf(objects: SceneObject[]): { center: THREE.Vector3; radius: number } {
  const center = new THREE.Vector3();
  for (const o of objects) center.add(new THREE.Vector3(o.position[0], o.position[1], o.position[2]));
  center.multiplyScalar(1 / Math.max(1, objects.length));
  let radius = 0.5;
  for (const o of objects) {
    const m = unitMetrics(o.kind);
    const maxS = Math.max(o.scale[0], o.scale[1], o.scale[2]);
    const objR = m.radius * maxS;
    const d = new THREE.Vector3(o.position[0], o.position[1], o.position[2]).distanceTo(center) + objR;
    radius = Math.max(radius, d);
  }
  return { center, radius };
}

export function generateSceneSpec(seed: number, difficulty: Difficulty): SceneSpec {
  // 乱数の消費順を固定することで決定論性を担保する。
  const rng = createRng(seed);
  const count = objectCount(rng, difficulty);

  const objects: SceneObject[] = [];
  for (let i = 0; i < count; i++) {
    objects.push(makeObject(rng, difficulty, i));
  }

  // カメラ: 被写体のバウンディングスフィアが画角に収まる距離を算出
  const { center, radius } = boundsOf(objects);
  const fov = rangeFloat(rng, 20, 80);
  const azimuth = rangeFloat(rng, 0, Math.PI * 2); // 方位
  const elevation = rangeFloat(rng, 0.2, 1.1); // 高さ(ラジアン)。やや上から見下ろし気味
  // 画角に収めるための最小距離: r / sin(fov/2)。垂直/水平の狭い方を基準に余裕を持たせる
  const vFov = (fov * Math.PI) / 180;
  const fitDist = radius / Math.sin(vFov / 2);
  const dist = fitDist * rangeFloat(rng, 1.15, 1.6); // 余白マージン

  const cx = center.x + dist * Math.cos(elevation) * Math.cos(azimuth);
  const cy = center.y + dist * Math.sin(elevation);
  const cz = center.z + dist * Math.cos(elevation) * Math.sin(azimuth);

  return {
    seed,
    difficulty,
    objects,
    camera: {
      fov,
      position: [cx, cy, cz],
      target: [center.x, center.y, center.z],
    },
  };
}

/** spec のオブジェクト種別に対応する単位ジオメトリを生成（metrics と寸法を一致させる） */
function makeGeometry(kind: PrimitiveKind): THREE.BufferGeometry {
  switch (kind) {
    case 'box':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 32, 24);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case 'cone':
      return new THREE.ConeGeometry(0.5, 1, 32);
    case 'torus':
      return new THREE.TorusGeometry(0.5, 0.15, 16, 32);
  }
}

export function buildScene(spec: SceneSpec): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  meshes: THREE.Mesh[];
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const meshes: THREE.Mesh[] = [];
  spec.objects.forEach((o, i) => {
    const geom = makeGeometry(o.kind);
    // ニュートラルグレー系。個体ごとに僅かに明度差（決定論的: index 由来）
    const lightness = 0.55 + ((i % 5) - 2) * 0.04;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0, 0, lightness),
      roughness: 0.85,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(o.position[0], o.position[1], o.position[2]);
    mesh.rotation.set(o.rotation[0], o.rotation[1], o.rotation[2]);
    mesh.scale.set(o.scale[0], o.scale[1], o.scale[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `obj_${i}_${o.kind}`;
    scene.add(mesh);
    meshes.push(mesh);
  });

  // 床面
  const groundGeom = new THREE.PlaneGeometry(50, 50);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1.0, metalness: 0.0 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(spec.camera.fov, 1, 0.1, 100);
  camera.position.set(spec.camera.position[0], spec.camera.position[1], spec.camera.position[2]);
  camera.lookAt(spec.camera.target[0], spec.camera.target[1], spec.camera.target[2]);

  return { scene, camera, meshes };
}
