import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Icon } from "./Icon";

import { VEHICLE_FEEDBACK_MAX_AGE_MS, type VehicleVisualState } from "../lib/vehicleState";
import { createTumblerModel, steeringYawForCommand, type TumblerModel } from "../vehicle/tumblerModel";
import { WheelMotion } from "../vehicle/wheelMotion";
import { createTumblerAtmosphere } from "../vehicle/tumblerAtmosphere";
import { createTumblerStreet } from "../vehicle/tumblerStreet";
import { createTumblerSignals, type TumblerSignals } from "../vehicle/tumblerSignals";
import { createTumblerRendering } from "../vehicle/tumblerRendering";
import { installTumblerSoftShadows } from "../vehicle/tumblerShadows";
import { TumblerShadowCache } from "../vehicle/tumblerShadowCache";
import {
  automaticCameraIntent, CAMERA_SHOTS, CAMERA_INTENT_DWELL_MS, CAMERA_IDLE_DWELL_MS, CAMERA_FRAMING_MIN_ASPECT,
  nearestOrbitAngle, stepCameraSpring, type CameraIntent, type CameraView
} from "../vehicle/tumblerCamera";

type ViewerController = { view: (part: CameraView) => void; refresh: () => void };
type Props = { state: VehicleVisualState; receivedAt: number | null; vehicleName: string; modelNumber?: string; developerMode: boolean };

const views: Array<{ id: CameraView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "steering", label: "Steering" },
  { id: "drive", label: "Rear drive" },
  { id: "reverse", label: "Reverse" },
  { id: "lights", label: "Lights" },
  { id: "attack", label: "Attack" },
  { id: "boost", label: "Boost" }
];

export function TumblerViewer({ state, receivedAt, vehicleName, modelNumber, developerMode }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ViewerController | null>(null);
  const cameraMenuRef = useRef<HTMLDetailsElement>(null);
  const feedbackRef = useRef({ state, receivedAt });
  const followRef = useRef(true);
  const streetRef = useRef(false);
  const [available, setAvailable] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [follow, setFollow] = useState(true);
  const [street, setStreet] = useState(false);
  const [cameraView, setCameraView] = useState<CameraView>("overview");
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    function dismissOutside(event: PointerEvent) {
      const menu = cameraMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, []);

  useEffect(() => {
    feedbackRef.current = { state, receivedAt };
    controllerRef.current?.refresh();
    // An idle model renders on demand. Still expire lamps/steering if the
    // telemetry stream disappears without another event.
    if (!state.live || receivedAt === null) return;
    const delay = Math.max(0, Math.min(VEHICLE_FEEDBACK_MAX_AGE_MS + 2, receivedAt + VEHICLE_FEEDBACK_MAX_AGE_MS + 2 - Date.now()));
    const timer = window.setTimeout(() => controllerRef.current?.refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [state, receivedAt]);
  useEffect(() => {
    followRef.current = follow;
    controllerRef.current?.refresh();
  }, [follow]);
  useEffect(() => {
    streetRef.current = street;
    controllerRef.current?.refresh();
  }, [street]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
    } catch {
      setAvailable(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    // Raw depth enables blocker search for contact-hardening PCSS and volume
    // occlusion. The material-local filter replaces Basic's hard comparison.
    renderer.shadowMap.type = THREE.BasicShadowMap;
    // The shadow cache updates only changed silhouettes, at a bounded cadence.
    renderer.shadowMap.autoUpdate = false;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Interactive Tumbler model");
    canvas.setAttribute("aria-describedby", "tumbler-view-help");
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
    camera.position.fromArray(CAMERA_SHOTS.overview.offset).add(new THREE.Vector3(0, 1.074, 0));
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1.074, 0);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 4.5;
    controls.maxDistance = 22;
    controls.minPolarAngle = 0.18;
    controls.maxPolarAngle = Math.PI / 2 - 0.035;
    controls.update();

    const atmosphere = createTumblerAtmosphere(scene, { reflections: renderer.extensions.has("EXT_color_buffer_float"), photographicLighting: true });
    const streetScene = createTumblerStreet(scene);
    const rendering = createTumblerRendering(renderer, scene, camera);
    const key = scene.getObjectByName("Tumbler cinematic shadow key") as THREE.DirectionalLight;
    const softShadows = installTumblerSoftShadows(scene, key);
    const shadowCache = new TumblerShadowCache();
    let signals: TumblerSignals | null = null;
    let model: TumblerModel | null = null;

    let animationFrame = 0;
    let destroyed = false;
    let cleanedUp = false;
    let intersecting = true;
    let lastTime = 0;
    let candidateView: CameraView = "overview";
    let candidateSince = 0;
    let lastIntentKey = "";
    let poseIntent: CameraIntent | undefined;
    let currentView: CameraView = "overview";
    let freeOrbit = false;
    let previousAspect = 0;
    let wheelRotation = 0;
    const wheelMotion = new WheelMotion();
    let steering = 0;
    let renderedFrames = 0;
    let transition: { orbit: THREE.Spherical; target: THREE.Vector3 } | null = null;
    const orbit = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const orbitVelocity = new THREE.Vector3();
    const targetVelocity = new THREE.Vector3();
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = motionPreference.matches;
    setReducedMotion(reduce);
    function chooseView(part: CameraView, intent?: CameraIntent) {
      currentView = part;
      poseIntent = intent;
      freeOrbit = false;
      const view = CAMERA_SHOTS[part];
      const target = model?.cameraTargets[view.focus].clone() ?? new THREE.Vector3(0, 1.074, 0);
      target.y += view.targetYOffset ?? 0;
      const destination = new THREE.Spherical().setFromVector3(new THREE.Vector3().fromArray(view.offset));
      if (intent) {
        // Move toward a side view while steering, without swapping camera sides
        // on every left/right correction. Keep both axles in the frame.
        const turn = Math.abs(intent.steeringBias);
        if (part === "drive" || part === "boost") destination.theta -= turn * 0.4;
        // Keep the rear coupler's cockpit sightline open at full steering.
        if (part === "reverse") destination.theta += Math.min(turn, 0.3) * 0.2;
        destination.radius *= 1 + turn * 0.08 + (intent.moving ? 0.03 : 0);
      }
      // Preserve framing on a narrow window and at larger text zoom.
      destination.radius = THREE.MathUtils.clamp(destination.radius * Math.max(1, CAMERA_FRAMING_MIN_ASPECT / camera.aspect), controls.minDistance, controls.maxDistance);
      destination.phi = THREE.MathUtils.clamp(destination.phi, controls.minPolarAngle, controls.maxPolarAngle);
      controls.update();
      if (!transition) {
        orbit.setFromVector3(camera.position.clone().sub(controls.target));
        orbitVelocity.set(0, 0, 0);
        targetVelocity.set(0, 0, 0);
      }
      destination.theta = nearestOrbitAngle(orbit.theta, destination.theta);
      if (reduce) {
        orbit.copy(destination);
        camera.position.setFromSpherical(destination).add(target);
        controls.target.copy(target);
        controls.update();
        transition = null;
      } else {
        transition = { orbit: destination, target };
      }
      canvas.dataset.cameraMoving = String(transition !== null);
      setCameraView(part);
      schedule();
    }

    function pauseFollow() {
      transition = null;
      freeOrbit = true;
      lastIntentKey = "";
      followRef.current = false;
      setFollow(false);
    }
    controls.addEventListener("start", pauseFollow);

    function onKey(event: KeyboardEvent) {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
      event.preventDefault();
      pauseFollow();
      if (event.key === "Home") { chooseView("overview"); return; }
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      if (event.key === "ArrowLeft") spherical.theta -= 0.16;
      if (event.key === "ArrowRight") spherical.theta += 0.16;
      if (event.key === "ArrowUp") spherical.phi -= 0.12;
      if (event.key === "ArrowDown") spherical.phi += 0.12;
      if (event.key === "+" || event.key === "=") spherical.radius *= 0.9;
      if (event.key === "-") spherical.radius *= 1.1;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
      spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
      camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(controls.target));
      controls.update();
      schedule();
    }
    canvas.addEventListener("keydown", onKey);

    function frame(time: number) {
      animationFrame = 0;
      if (destroyed || document.hidden || !intersecting) return;
      if (!model) return;
      // Limit rendering to 30 fps on battery-powered devices.
      if (lastTime && time - lastTime < 32) { schedule(); return; }
      const dt = Math.min((time - (lastTime || time)) / 1000, 0.05);
      lastTime = time;
      const feedback = feedbackRef.current;
      const age = feedback.receivedAt === null ? Infinity : Date.now() - feedback.receivedAt;
      const fresh = feedback.state.live && feedback.receivedAt !== null
        && age >= 0 && age <= VEHICLE_FEEDBACK_MAX_AGE_MS;
      const current = feedback.state;
      const targetSteering = fresh ? steeringYawForCommand(current.steering) : 0;
      steering = reduce ? targetSteering : THREE.MathUtils.damp(steering, targetSteering, 12, dt);
      for (const wheel of model.frontSteering) wheel.rotation.y = steering;
      // Interpolate measured drivetrain travel independently of camera timing.
      const wheelSampledAt = performance.now();
      wheelRotation = wheelMotion.advance(wheelSampledAt);
      // Smaller front tires rotate faster than the rear pairs.
      for (let index = 0; index < model.wheelSpins.length; index += 1) {
        model.wheelSpins[index].rotation.x = wheelRotation * model.wheelRollRatios[index];
      }
      // The road and haze use the same interpolated encoder travel as the tires.
      // This never substitutes trigger pressure for measured movement.
      const travel = wheelRotation * model.rearWheelRadius;
      atmosphere.update(travel, reduce, streetRef.current);
      streetScene.setEnabled(streetRef.current);
      const pulsePhase = reduce ? 1 : Math.sin(time * 0.025) ** 2;
      const pulse = 0.4 + 0.6 * pulsePhase;
      const lightIntensity = fresh && current.attack ? 4 * pulse : fresh && current.lights ? 2.4 : 0.04;
      for (const light of model.lightMaterials) light.emissiveIntensity = lightIntensity;
      model.boostMaterial.emissiveIntensity = fresh && current.boost ? 4 * pulse : 0.04;
      // Attack flickers the same three green optical assemblies used by
      // reverse. It takes priority during its active window, then the lamps
      // resume the bridge's resolved reverse phase. Reduced motion stays lit.
      const greenOn = fresh && (current.attack ? pulsePhase >= 0.5 : current.rocketLights);
      model.setReverseLights(greenOn);
      const lampSignals = {
        white: fresh && (current.attack || current.lights) ? lightIntensity / 4 : 0,
        green: greenOn ? 1 : 0,
        boost: fresh && current.boost ? pulse : 0
      };
      signals?.update(lampSignals);

      let pendingIntent = false;
      if (followRef.current && !reduce) {
        const intent = fresh ? automaticCameraIntent(current) : { view: "overview" as const, steeringBias: 0, moving: false };
        if (candidateView !== intent.view) {
          candidateView = intent.view;
          candidateSince = time;
        }
        const dwell = intent.view === "overview" ? CAMERA_IDLE_DWELL_MS : CAMERA_INTENT_DWELL_MS;
        pendingIntent = currentView !== intent.view && time - candidateSince < dwell;
        if (!pendingIntent) {
          const key = `${intent.view}:${intent.moving}:${Math.abs(intent.steeringBias).toFixed(2)}`;
          if (key !== lastIntentKey) {
            lastIntentKey = key;
            chooseView(intent.view, intent);
          }
        }
      }
      if (transition) {
        const radius = stepCameraSpring({ value: orbit.radius, velocity: orbitVelocity.x }, transition.orbit.radius, dt);
        const phi = stepCameraSpring({ value: orbit.phi, velocity: orbitVelocity.y }, transition.orbit.phi, dt);
        const theta = stepCameraSpring({ value: orbit.theta, velocity: orbitVelocity.z }, transition.orbit.theta, dt);
        orbit.set(Math.max(controls.minDistance, radius.value), THREE.MathUtils.clamp(phi.value, controls.minPolarAngle, controls.maxPolarAngle), theta.value);
        orbitVelocity.set(radius.velocity, phi.velocity, theta.velocity);
        for (const axis of ["x", "y", "z"] as const) {
          const next = stepCameraSpring({ value: controls.target[axis], velocity: targetVelocity[axis] }, transition.target[axis], dt);
          controls.target[axis] = next.value;
          targetVelocity[axis] = next.velocity;
        }
        camera.position.setFromSpherical(orbit).add(controls.target);
        if (Math.abs(orbit.radius - transition.orbit.radius) < 0.002
          && Math.abs(orbit.phi - transition.orbit.phi) < 0.0003
          && Math.abs(orbit.theta - transition.orbit.theta) < 0.0003
          && controls.target.distanceToSquared(transition.target) < 0.000004
          && orbitVelocity.lengthSq() + targetVelocity.lengthSq() < 0.0001) {
          orbit.copy(transition.orbit);
          camera.position.setFromSpherical(orbit).add(transition.target);
          controls.target.copy(transition.target);
          transition = null;
        }
      }
      const cameraChanged = controls.update();
      if (streetRef.current) streetScene.update(travel, camera.position);
      softShadows.update();
      if (shadowCache.sample(time, {
        steering, wheelRotation, travel, streetEnabled: streetRef.current,
        clearance: [streetScene.clearance.x, streetScene.clearance.y]
      })) {
        renderer.shadowMap.needsUpdate = true;
      }
      rendering.render();
      canvas.dataset.streetScene = String(streetRef.current);
      canvas.dataset.streetTravel = travel.toFixed(5);
      canvas.dataset.lampEffects = [lampSignals.white, lampSignals.green, lampSignals.boost].map((value) => value.toFixed(4)).join(",");
      canvas.dataset.renderCalls = String(rendering.calls);
      canvas.dataset.renderTriangles = String(rendering.triangles);
      canvas.dataset.shadowCalls = String(rendering.shadowCalls);
      canvas.dataset.shadowTriangles = String(rendering.shadowTriangles);
      canvas.dataset.enhancedGraphics = String(rendering.enhanced);
      canvas.dataset.volumetricLighting = String(rendering.volumetric);
      canvas.dataset.softShadowMaterials = String(softShadows.materialCount);
      canvas.dataset.shadowTechnique = "pcss";
      canvas.dataset.antialias = rendering.antialias;
      canvas.dataset.multisampleCount = String(rendering.samples);
      canvas.dataset.reflectionCalls = String(streetRef.current ? atmosphere.reflectionCalls : 0);
      canvas.dataset.reflectionTriangles = String(streetRef.current ? atmosphere.reflectionTriangles : 0);
      canvas.dataset.renderedFrames = String(++renderedFrames);
      canvas.dataset.steering = steering.toFixed(4);
      canvas.dataset.wheelRotation = wheelRotation.toFixed(4);
      canvas.dataset.wheelAngularVelocity = wheelMotion.angularVelocity.toFixed(4);
      canvas.dataset.wheelMotionBasis = current.motionBasis;
      canvas.dataset.wheelSampledAt = wheelSampledAt.toFixed(3);
      canvas.dataset.cameraPosition = camera.position.toArray().map((value) => value.toFixed(3)).join(",");
      canvas.dataset.cameraTarget = controls.target.toArray().map((value) => value.toFixed(3)).join(",");
      canvas.dataset.cameraMoving = String(transition !== null);
      canvas.dataset.frontLightIntensity = model.lightMaterials[0].emissiveIntensity.toFixed(3);
      canvas.dataset.attackLightIntensity = (fresh && current.attack ? lightIntensity : 0).toFixed(3);
      canvas.dataset.boostIntensity = model.boostMaterial.emissiveIntensity.toFixed(3);
      canvas.dataset.reverseLightIntensities = model.reverseLightMaterials.map((light) => light.emissiveIntensity.toFixed(3)).join(",");
      canvas.dataset.braking = String(fresh && current.brake);
      if (transition || pendingIntent || cameraChanged || Math.abs(steering - targetSteering) > 0.0001
        || (fresh && !reduce && (wheelMotion.pending || current.attack || current.boost))) schedule();
    }
    function schedule() {
      if (!destroyed && !animationFrame && !document.hidden && intersecting) animationFrame = requestAnimationFrame(frame);
    }
    function resize() {
      const { width, height } = host!.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      rendering.resize(width, height);
      atmosphere.resize(width, height);
      if (!freeOrbit && Math.abs(previousAspect - camera.aspect) > 0.05) chooseView(currentView, poseIntent);
      previousAspect = camera.aspect;
      schedule();
    }
    function updateWheelFeedback() {
      const feedback = feedbackRef.current;
      wheelMotion.update(feedback.state, feedback.receivedAt, Date.now(), performance.now());
    }
    function updateWheelVisibility() {
      wheelMotion.setRunning(model !== null && !document.hidden && intersecting && !reduce, performance.now());
      updateWheelFeedback();
    }
    function visibilityChanged() { lastTime = 0; updateWheelVisibility(); schedule(); }
    function preferenceChanged() {
      reduce = motionPreference.matches;
      setReducedMotion(reduce);
      transition = null;
      lastIntentKey = "";
      updateWheelVisibility();
      schedule();
    }
    function contextLost(event: Event) {
      event.preventDefault();
      setAvailable(false);
      cleanup();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      lastTime = 0;
      updateWheelVisibility();
      schedule();
    });
    visibilityObserver.observe(host);
    document.addEventListener("visibilitychange", visibilityChanged);
    motionPreference.addEventListener("change", preferenceChanged);
    canvas.addEventListener("webglcontextlost", contextLost);
    controls.addEventListener("change", schedule);
    controllerRef.current = {
      view: (part) => { lastIntentKey = ""; chooseView(part); },
      refresh: () => { updateWheelFeedback(); schedule(); }
    };
    resize();
    chooseView("overview");
    canvas.dataset.surfaceTexturesReady = "false";
    void rendering.ready.then(() => { if (!destroyed) schedule(); });
    void Promise.all([atmosphere.ready, streetScene.ready]).then((ready) => {
      if (destroyed) return;
      canvas.dataset.surfaceTexturesReady = String(ready.every(Boolean));
      schedule();
    });
    void createTumblerModel().then((vehicle) => {
      if (destroyed) { vehicle.dispose(); return; }
      model = vehicle;
      updateWheelFeedback();
      updateWheelVisibility();
      scene.add(vehicle.root);
      signals = createTumblerSignals(scene, vehicle, { volumetric: rendering.volumetric });
      softShadows.refresh();
      shadowCache.invalidate();
      setLoaded(true);
      chooseView("overview");
      schedule();
    }).catch(() => {
      if (!destroyed) {
        setAvailable(false);
        cleanup();
      }
    });

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      controllerRef.current = null;
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionPreference.removeEventListener("change", preferenceChanged);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("keydown", onKey);
      controls.removeEventListener("start", pauseFollow);
      controls.removeEventListener("change", schedule);
      controls.dispose();
      signals?.dispose();
      signals = null;
      rendering.dispose();
      softShadows.dispose();
      streetScene.dispose();
      atmosphere.dispose();
      model?.dispose();
      model = null;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    }
    return cleanup;
  }, []);

  function selectView(view: CameraView) {
    setFollow(false);
    followRef.current = false;
    controllerRef.current?.view(view);
    closeCameraMenu();
  }

  function closeCameraMenu() {
    if (!cameraMenuRef.current) return;
    cameraMenuRef.current.open = false;
    cameraMenuRef.current.querySelector("summary")?.focus({ preventScroll: true });
  }

  const currentViewLabel = views.find((view) => view.id === cameraView)?.label ?? "Combined";

  return (
    <div className="tumbler-viewer" data-live={state.live} data-active-part={state.activePart ?? ""} data-camera-view={cameraView} data-street-scene={street}>
      <div className="vehicle-art">
        <div className="tumbler-viewer__viewport">
          <div className="tumbler-viewer__stage" ref={hostRef} hidden={!available} />
          {available && !loaded && <p className="tumbler-viewer__loading" role="status">Loading your Tumbler…</p>}
          {!available && (
            <div className="tumbler-viewer__fallback" role="status">
              <strong>3D preview unavailable</strong>
              <p>The model could not be displayed. You can still connect and drive.</p>
            </div>
          )}
        </div>
        <span id="tumbler-view-help" className="sr-only">Drag to orbit, scroll to zoom. Keyboard: arrow keys orbit, plus and minus zoom, Home resets the view.</span>
        {developerMode && <div className="tumbler-viewer__diagnostics">
          <div className="tumbler-viewer__info">
            <span className={`tumbler-feedback ${state.live ? "tumbler-feedback--live" : ""}`} role="status">
              <i aria-hidden="true" />{state.statusLabel}
            </span>
          </div>
          <p className="tumbler-viewer__note">{state.live ? state.wheelPosition
            ? "Wheels follow measured drivetrain movement. Steering and lights follow controls."
            : "Wheel animation starts when the car reports movement."
            : "Connect your Tumbler to see its controls in motion."}</p>
        </div>}
      </div>
      <div className="vehicle-card__bottom">
        <div className="vehicle-name">
          <p className="eyebrow">{modelNumber ? `MODEL ${modelNumber}` : "YOUR BUILD"}</p>
          <div className="vehicle-name__row">
            <h2>{vehicleName}</h2>
            <details className="tumbler-viewer__toolbar" ref={cameraMenuRef}
              onKeyDown={(event) => {
                if (event.key === "Escape" && cameraMenuRef.current?.open) {
                  event.preventDefault();
                  event.stopPropagation();
                  closeCameraMenu();
                }
              }}>
              <summary aria-label="Camera views" aria-disabled={!available || !loaded}
                title={`Camera view: ${currentViewLabel}`}
                onClick={(event) => { if (!available || !loaded) event.preventDefault(); }}>
                <span>View</span>
                {follow && !reducedMotion && <span className="tumbler-viewer__auto" aria-hidden="true">Auto</span>}
                <Icon name="chevron" size={16} />
              </summary>
              <div className="tumbler-viewer__camera-panel">
                <p className="tumbler-viewer__camera-heading">Camera views <span>{currentViewLabel}</span></p>
                <div className="tumbler-viewer__views" role="group" aria-label="Vehicle camera views">
                  {views.map(({ id, label }) => (
                    <button key={id} type="button" disabled={!available || !loaded} aria-pressed={cameraView === id}
                      className={state.activePart === id ? "tumbler-view--active" : ""} onClick={() => selectView(id)}>{label}</button>
                  ))}
                </div>
                <label className="tumbler-follow">
                  <input type="checkbox" checked={follow && !reducedMotion} disabled={!available || !loaded || reducedMotion}
                    onChange={(event) => setFollow(event.target.checked)} />
                  Follow active part
                </label>
                <label className="tumbler-street">
                  <input type="checkbox" checked={street} disabled={!available || !loaded}
                    onChange={(event) => setStreet(event.target.checked)} />
                  Street scene
                </label>
                <p className="tumbler-viewer__camera-help">{reducedMotion
                  ? "Automatic views paused for reduced motion."
                  : "Drag to orbit · Scroll to zoom"}</p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
