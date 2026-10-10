import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TextureLibrary } from '../src/utils/TextureLibrary.js';
import { buildRoof, buildWallCap, buildCornerTower } from '../src/scene/RoofBuilder.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0xc9dce8, 80, 280);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 500);
camera.position.set(0, 22, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 12, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.update();

const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff8e8, 1.2);
sun.position.set(50, 80, 40);
sun.castShadow = true;
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 200;
sun.shadow.mapSize.width = 2048;
sun.shadow.mapSize.height = 2048;
sun.shadow.bias = -0.0005;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({ color: 0xa0927a, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const info = document.getElementById('info');
info.textContent = '加载贴图...';

const lib = new TextureLibrary({ quality: 'hd', anisotropy: 4 });
await lib.load((done, total) => {
  info.textContent = `加载贴图 ${done}/${total}`;
});

info.textContent = '生成屋顶...';

const roofs = [];
let x = -100;
const z0 = -20;

// 庑殿单檐（太和殿规模）
const wudian1 = buildRoof(lib, { type: 'wudian', width: 63, depth: 37, baseY: 12, layers: 1, detail: 'high' });
wudian1.position.set(x, 0, z0);
scene.add(wudian1);
roofs.push({ name: '庑殿单檐', obj: wudian1, x, z: z0 });
x += 80;

// 庑殿重檐（太和殿）
const wudian2 = buildRoof(lib, { type: 'wudian', width: 63, depth: 37, baseY: 12, layers: 2, detail: 'high' });
wudian2.position.set(x, 0, z0);
scene.add(wudian2);
roofs.push({ name: '庑殿重檐', obj: wudian2, x, z: z0 });
x += 80;

// 歇山单檐（保和殿规模）
const xieshan1 = buildRoof(lib, { type: 'xieshan', width: 55, depth: 34, baseY: 11, layers: 1, detail: 'high' });
xieshan1.position.set(x, 0, z0);
scene.add(xieshan1);
roofs.push({ name: '歇山单檐', obj: xieshan1, x, z: z0 });

x = -100;
const z1 = 60;

// 歇山重檐（乾清宫规模）
const xieshan2 = buildRoof(lib, { type: 'xieshan', width: 42, depth: 28, baseY: 10, layers: 2, detail: 'high' });
xieshan2.position.set(x, 0, z1);
scene.add(xieshan2);
roofs.push({ name: '歇山重檐', obj: xieshan2, x, z: z1 });
x += 55;

// 攒尖四角（中和殿）
const pavilion4 = buildRoof(lib, { type: 'pavilion', width: 25, depth: 25, baseY: 9, sides: 4, layers: 1, detail: 'high' });
pavilion4.position.set(x, 0, z1);
scene.add(pavilion4);
roofs.push({ name: '攒尖四角', obj: pavilion4, x, z: z1 });
x += 35;

// 攒尖八角
const pavilion8 = buildRoof(lib, { type: 'pavilion', width: 18, depth: 18, baseY: 8, sides: 8, layers: 1, detail: 'high' });
pavilion8.position.set(x, 0, z1);
scene.add(pavilion8);
roofs.push({ name: '攒尖八角', obj: pavilion8, x, z: z1 });
x += 28;

// 硬山（庑房）
const gable = buildRoof(lib, { type: 'gable', width: 32, depth: 18, baseY: 7, layers: 1, detail: 'high' });
gable.position.set(x, 0, z1);
scene.add(gable);
roofs.push({ name: '硬山', obj: gable, x, z: z1 });
x += 40;

// 攒尖重檐
const pavilion2 = buildRoof(lib, { type: 'pavilion', width: 22, depth: 22, baseY: 9, sides: 4, layers: 2, detail: 'high' });
pavilion2.position.set(x, 0, z1);
scene.add(pavilion2);
roofs.push({ name: '攒尖重檐', obj: pavilion2, x, z: z1 });

// 墙帽（长段）
const wallCap = buildWallCap(lib, { length: 40, thickness: 2.4 });
wallCap.position.set(-80, 0, -60);
scene.add(wallCap);
roofs.push({ name: '墙帽', obj: wallCap, x: -80, z: -60 });

// 角楼
const tower = buildCornerTower(lib, { size: 14 });
tower.position.set(50, 0, -60);
scene.add(tower);
roofs.push({ name: '角楼', obj: tower, x: 50, z: -60 });

info.textContent = '计算三角面...';

let totalTris = 0;
let totalMeshes = 0;
const details = [];
roofs.forEach(r => {
  let tris = 0, meshes = 0;
  r.obj.traverse(o => {
    if (o.isMesh) {
      meshes++;
      tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    }
  });
  totalTris += tris;
  totalMeshes += meshes;
  details.push(`${r.name}: ${Math.round(tris).toLocaleString()} 三角面, ${meshes} mesh`);
});

info.innerHTML = `<b>屋顶预览</b><br/>` +
  `总计: ${Math.round(totalTris).toLocaleString()} 三角面, ${totalMeshes} meshes<br/><br/>` +
  details.join('<br/>');

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();

window.__roofPreview = { scene, camera, renderer, roofs, lib };
