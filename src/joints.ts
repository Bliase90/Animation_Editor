import * as THREE from 'three';
import type { Viewer } from './viewer';

/** Clickable joint markers and bone lines drawn on top of the character. */
export class JointMarkers {
  private group = new THREE.Group();
  private markers: { bone: THREE.Bone; mesh: THREE.Mesh }[] = [];
  private lines: THREE.LineSegments | null = null;
  private raycaster = new THREE.Raycaster();
  private baseMat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, depthTest: false, transparent: true, opacity: 0.85 });
  private sideMatL = new THREE.MeshBasicMaterial({ color: 0x81c784, depthTest: false, transparent: true, opacity: 0.85 });
  private sideMatR = new THREE.MeshBasicMaterial({ color: 0xffb74d, depthTest: false, transparent: true, opacity: 0.85 });
  private selMat = new THREE.MeshBasicMaterial({ color: 0xff4081, depthTest: false });
  private selected: THREE.Bone | null = null;
  visible = true;

  constructor(private viewer: Viewer) {
    viewer.overlay.add(this.group);
  }

  setBones(bones: THREE.Bone[], canonical: (b: THREE.Bone) => string | null, radius: number) {
    this.group.clear();
    this.markers = [];
    const geo = new THREE.SphereGeometry(radius, 12, 8);
    for (const bone of bones) {
      const c = canonical(bone);
      if (!c || /_End$/.test(c)) continue;
      const small = /Hand(Thumb|Index|Middle|Ring|Pinky)|Eye/.test(c);
      const mesh = new THREE.Mesh(geo, c.startsWith('Left') ? this.sideMatL : c.startsWith('Right') ? this.sideMatR : this.baseMat);
      if (small) mesh.scale.setScalar(0.5);
      mesh.renderOrder = 10;
      mesh.userData.bone = bone;
      mesh.userData.baseMaterial = mesh.material;
      this.group.add(mesh);
      this.markers.push({ bone, mesh });
    }
    const positions = new Float32Array(this.markers.length * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x9fa8da, depthTest: false, transparent: true, opacity: 0.6 }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 9;
    this.group.add(this.lines);
    this.select(null);
  }

  update() {
    this.group.visible = this.visible && this.markers.length > 0;
    if (!this.group.visible) return;
    const p = new THREE.Vector3();
    const attr = this.lines!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = new Map(this.markers.map((m) => [m.bone, m]));
    this.markers.forEach((m, i) => {
      m.bone.getWorldPosition(p);
      m.mesh.position.copy(p);
      // Line to nearest marked ancestor.
      let parent = m.bone.parent;
      while (parent && !index.has(parent as THREE.Bone)) parent = parent.parent;
      const from = parent ? index.get(parent as THREE.Bone)!.mesh.position : p;
      attr.setXYZ(i * 2, from.x, from.y, from.z);
      attr.setXYZ(i * 2 + 1, p.x, p.y, p.z);
    });
    attr.needsUpdate = true;
  }

  select(bone: THREE.Bone | null) {
    this.selected = bone;
    for (const m of this.markers) m.mesh.material = m.bone === bone ? this.selMat : m.mesh.userData.baseMaterial;
  }

  get selectedBone() { return this.selected; }

  pick(event: PointerEvent): THREE.Bone | null {
    if (!this.group.visible) return null;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = this.raycaster.intersectObjects(this.markers.map((m) => m.mesh), false);
    return hits.length ? (hits[0].object.userData.bone as THREE.Bone) : null;
  }
}
