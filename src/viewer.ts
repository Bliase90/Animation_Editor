import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'three_quarter' | 'top' | 'current';
export const VIEWS: ViewName[] = ['front', 'three_quarter', 'right', 'left', 'back', 'top', 'current'];

/** Scene, camera, renderer and render loop. Knows nothing about rigs. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Drawn after the main scene with depth cleared, so joints stay visible through the mesh. */
  readonly overlay = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  readonly stage = new THREE.Group();
  private grid: THREE.GridHelper;
  private onFrame: ((dt: number) => void)[] = [];
  private clock = new THREE.Clock();
  /** Character height used to frame views, in metres. */
  focusHeight = 1.8;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x24262b);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x99bbff, 1.2);
    rim.position.set(-4, 3, -4);
    this.scene.add(rim);
    this.grid = new THREE.GridHelper(10, 20, 0x5a5f6b, 0x383b42);
    this.scene.add(this.grid);
    this.scene.add(this.stage);

    this.camera.position.set(0, 1.4, 4);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setMode('rotate');
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.overlay.add(this.gizmo.getHelper());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  addFrameListener(fn: (dt: number) => void) { this.onFrame.push(fn); }

  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick() {
    const dt = this.clock.getDelta();
    for (const fn of this.onFrame) fn(dt);
    this.render();
  }

  render(camera: THREE.Camera = this.camera, withOverlay = true) {
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    if (withOverlay) {
      this.renderer.clearDepth();
      this.renderer.render(this.overlay, camera);
    }
  }

  /** Places a camera on one of the named views around the character. */
  placeCamera(cam: THREE.PerspectiveCamera, view: ViewName) {
    if (view === 'current') { cam.position.copy(this.camera.position); cam.quaternion.copy(this.camera.quaternion); return; }
    const h = this.focusHeight;
    const target = new THREE.Vector3(0, h * 0.53, 0);
    const dist = h * 2.1;
    const dirs: Record<Exclude<ViewName, 'current'>, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0.08, 1),
      back: new THREE.Vector3(0, 0.08, -1),
      left: new THREE.Vector3(1, 0.08, 0), // the character's left side
      right: new THREE.Vector3(-1, 0.08, 0),
      three_quarter: new THREE.Vector3(0.7, 0.2, 0.75),
      top: new THREE.Vector3(0, 1, 0.001),
    };
    cam.position.copy(target).addScaledVector(dirs[view].normalize(), dist);
    cam.lookAt(target);
  }

  setView(view: ViewName) {
    if (view === 'current') return;
    this.placeCamera(this.camera, view);
    this.orbit.target.set(0, this.focusHeight * 0.53, 0);
    this.orbit.update();
  }

  /**
   * Renders one frame from `view` at the given size into a new canvas.
   * Joint markers and the gizmo are hidden so the image shows only the character.
   */
  snapshot(view: ViewName, width = 768, height = 768): HTMLCanvasElement {
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    const prevRatio = this.renderer.getPixelRatio();
    const cam = new THREE.PerspectiveCamera(this.camera.fov, width / height, 0.01, 1000);
    this.placeCamera(cam, view);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.render(cam, false);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0, width, height, 0, 0, width, height);
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setSize(prev.x, prev.y, false);
    this.render();
    return out;
  }

  capture(view: ViewName, width = 768, height = 768): string {
    return this.snapshot(view, width, height).toDataURL('image/png');
  }
}
