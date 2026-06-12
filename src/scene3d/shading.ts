// ライトプリセットとトゥーン段階シェーディング。
import * as THREE from 'three';
import { rangeFloat } from './random.ts';

export type LightPreset = 'key1' | 'threePoint'; // 1灯キー / 3点照明
export type ShadingSteps = 2 | 3 | 0; // 2値 / 3値 / 連続(0)

// シェーディング適用後に gradientMap を破棄できるよう、生成したテクスチャを保持する用途は無し
// （メッシュ側 material.dispose で解放）。ここでは段階トーンの DataTexture を都度生成する。

/** N段階の階調を表す gradientMap（横長 1px、NearestFilter で段化） */
function makeGradientMap(steps: number): THREE.DataTexture {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    // 0..255 を steps 段に等分。最暗を少し持ち上げて完全な黒つぶれを避ける
    const v = Math.round(((i + 0.5) / steps) * 255);
    data[i] = v;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * ライトをシーンに追加。preset='key1' は seed 由来 rng でキー光の方位を僅かに乱数化可。
 * 既存ライトは置き換えのため呼び出し前に除去すること（重複追加を避ける）。
 */
export function setupLights(scene: THREE.Scene, preset: LightPreset, rng?: () => number): void {
  // 既存の自前ライトを除去（name 'al_light_*'）
  const stale = scene.children.filter((c) => c.name.startsWith('al_light_'));
  for (const s of stale) scene.remove(s);

  const r = rng ?? (() => 0.5);

  // 影品質の共通設定
  const configShadow = (light: THREE.DirectionalLight) => {
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    const cam = light.shadow.camera;
    cam.near = 0.1;
    cam.far = 50;
    cam.left = -8;
    cam.right = 8;
    cam.top = 8;
    cam.bottom = -8;
    light.shadow.bias = -0.0005;
  };

  if (preset === 'key1') {
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    ambient.name = 'al_light_ambient';
    scene.add(ambient);

    // キー光の方位を僅かに乱数化（azimuth ±, elevation）
    const az = rangeFloat(r, Math.PI * 0.15, Math.PI * 0.6);
    const el = rangeFloat(r, 0.6, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    const d = 10;
    key.position.set(d * Math.cos(el) * Math.cos(az), d * Math.sin(el), d * Math.cos(el) * Math.sin(az));
    key.name = 'al_light_key';
    configShadow(key);
    scene.add(key);
    scene.add(key.target);
  } else {
    // 3点照明: key + fill + rim
    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    ambient.name = 'al_light_ambient';
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(6, 8, 6);
    key.name = 'al_light_key';
    configShadow(key);
    scene.add(key);
    scene.add(key.target);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-7, 4, 3);
    fill.name = 'al_light_fill';
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-2, 5, -8);
    rim.name = 'al_light_rim';
    scene.add(rim);
  }
}

/**
 * メッシュ群へシェーディングを適用。
 * - steps 2/3: MeshToonMaterial + gradientMap（NearestFilter）で段階化
 * - steps 0  : MeshStandardMaterial（連続）
 * 元マテリアルの色を引き継ぐ。床メッシュには適用しない想定（meshes に含めない）。
 */
export function applyShading(meshes: THREE.Mesh[], steps: ShadingSteps): void {
  // 段階用 gradientMap は全メッシュで共有（同一段数なら使い回し）
  const gradient = steps === 0 ? null : makeGradientMap(steps);

  for (const mesh of meshes) {
    const prev = mesh.material as THREE.Material & { color?: THREE.Color };
    const color = prev.color ? prev.color.clone() : new THREE.Color(0x8c8c8c);

    let next: THREE.Material;
    if (steps === 0) {
      next = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 });
    } else {
      next = new THREE.MeshToonMaterial({ color, gradientMap: gradient! });
    }
    // 旧マテリアルを解放してから差し替え
    prev.dispose();
    mesh.material = next;
  }
}
