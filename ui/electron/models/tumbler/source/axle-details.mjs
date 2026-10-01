import * as THREE from 'three';

// Editable adaptations of details absent from the Studio assembly. See
// references.md: official steps51,127,128,168,186. Curves/artwork are reconstructed,
// not extracted official CAD or scans. All coordinates here are original LDU.
export const detailsProvenance = {
  frontGuides: { part: '40002c06', lengthMillimeters: 48, diameterMillimeters: 3.2,
    reference: 'Official instructions6675742, pages124–125, steps127–128',
    qualification: 'Coupler anchors follow CAD; free bends and pin placement inferred from instructions.' },
  graphics: { reference: 'Official instructions6675742, pages53,166,176',
    qualification: 'Hand-authored geometry approximates muted bat graphic and paired gold instrument circles; no photograph textures.' },
};

export async function addTumblerDetails(authored, loader) {
  const surfaces = {
    clear: loader.getMaterial('47'), black: loader.getMaterial('0'),
    gray: new THREE.MeshStandardMaterial({ color: '#505657', roughness: 0.55 }),
    gold: new THREE.MeshStandardMaterial({ color: '#d4ad42', roughness: 0.55 }),
    white: new THREE.MeshStandardMaterial({ color: '#e7e8e2', roughness: 0.25 }),
  };
  surfaces.gray.userData.code = 'Axle_nose_graphic';
  surfaces.gold.userData.code = 'Axle_side_graphic';
  surfaces.white.userData.code = 'Axle_headlamp_tip';
  for (const [i, z] of [59.98, -60.02].entries()) {
    const x = i === 0 ? 3.22 : 3.20;
    const y = i === 0 ? -142.10 : -142.11;
    const opening = new THREE.Vector3(x, y, z);
    const bendEnd = new THREE.Vector3(-35, -162, z);
    const bend = new THREE.CubicBezierCurve3(opening,
      new THREE.Vector3(-10, y, z), new THREE.Vector3(-15, -162, z), bendEnd);
    const endX = -35 - (120 - 20 - bend.getLength());
    const endpoint = new THREE.Vector3(endX, -162, z);
    const route = new THREE.CurvePath();
    route.add(new THREE.LineCurve3(new THREE.Vector3(x + 20, y, z), opening));
    route.add(bend);
    route.add(new THREE.LineCurve3(bendEnd, endpoint));
    const guide = new THREE.Mesh(new THREE.TubeGeometry(route, 48, 4, 12, false), surfaces.clear);
    guide.name = `Axle front guide${i}`;
    authored.add(guide);
    const pin = await loader.partsCache.getCachedModel('2780.dat');
    if (!pin) throw new Error('The local2780 pin geometry is missing');
    pin.traverse((object) => { if (object.isMesh) object.material = surfaces.black; });
    pin.matrixAutoUpdate = false;
    pin.matrix.set(0, -1, 0, endX + 20, 1, 0, 0, -162, 0, 0, 1, z, 0, 0, 0, 1);
    authored.add(pin);
    const tip = new THREE.Mesh(new THREE.CircleGeometry(3.9, 20), surfaces.white);
    tip.rotation.y = -Math.PI / 2;
    tip.position.copy(endpoint).add(new THREE.Vector3(-0.25, 0, 0));
    tip.userData.axleFeature = i === 0 ? 'frontLightLeft' : 'frontLightRight';
    authored.add(tip);
  }

  authored.updateMatrixWorld(true);
  const nose = [];
  const sides = [];
  authored.traverse((object) => {
    if (object.name.toLowerCase() === '71709.dat'
      && object.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(-150.9583, -121.9996, -0.01824)) < 0.1) nose.push(object);
    if (object.name.toLowerCase() !== '71682.dat') return;
    for (let parent = object.parent; parent; parent = parent.parent) {
      if (/^submodel group (44|45)$/i.test(parent.name)) { sides.push(object); break; }
    }
  });
  if (nose.length !== 1 || sides.length !== 2) throw new Error('Missing source panels for Tumbler graphic placement');
  const bat = new THREE.Shape();
  const points = [[-20,8],[-17,-3],[-11,1],[-7,-6],[-3,-2],[-2,-9],[0,-5],[2,-9],[3,-2],[7,-6],[11,1],[17,-3],[20,8],[12,5],[8,8],[3,6],[0,12],[-3,6],[-8,8],[-12,5]];
  points.forEach(([x, y], index) => index ? bat.lineTo(x, y) : bat.moveTo(x, y));
  bat.closePath();
  const graphic = new THREE.ShapeGeometry(bat);
  const vertices = graphic.getAttribute('position');
  for (let i = 0; i < vertices.count; i += 1) {
    const x = vertices.getX(i), y = vertices.getY(i);
    vertices.setXYZ(i, -y, -9.25, x);
  }
  graphic.computeVertexNormals();
  const noseGraphic = new THREE.Mesh(graphic, surfaces.gray);
  noseGraphic.matrixAutoUpdate = false;
  noseGraphic.matrix.copy(nose[0].matrixWorld);
  authored.add(noseGraphic);

  // Conform the circular marks to the curved panel instead of floating a flat
  // sticker through its surface. 71682's outer profile is a55LDU circular arc.
  function curvedCircle(radius, centerZ, material, panel, lift) {
    const geometry = new THREE.CircleGeometry(radius, 24);
    const attribute = geometry.getAttribute('position');
    for (let i = 0; i < attribute.count; i += 1) {
      const angle = 0.36 + attribute.getX(i) / 55;
      const z = centerZ + attribute.getY(i);
      attribute.setXYZ(i, -46 + (55 + lift) * Math.cos(angle), -(55 + lift) * Math.sin(angle), z);
    }
    for (let i = 0; i < geometry.index.count; i += 3) {
      const temporary = geometry.index.array[i + 1];
      geometry.index.array[i + 1] = geometry.index.array[i + 2];
      geometry.index.array[i + 2] = temporary;
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(panel.matrixWorld);
    authored.add(mesh);
  }
  for (const side of sides) for (const center of [-13, 13]) {
    curvedCircle(6.2, center, surfaces.gold, side, 0.22);
    curvedCircle(4.6, center, surfaces.black, side, 0.3);
    curvedCircle(1.5, center, surfaces.gold, side, 0.36);
  }
  authored.updateMatrixWorld(true);
}
