export function controllerControls(profile: string) {
  const dualSense = profile === "dualsense";
  const automatic = profile === "auto";

  return {
    forward: dualSense ? "R2" : automatic ? "R2 / RT" : "RT",
    reverse: dualSense ? "L2" : automatic ? "L2 / LT" : "LT",
    brake: dualSense ? "L1" : automatic ? "L1 / LB" : "LB",
    boost: dualSense ? "R1" : automatic ? "R1 / RB" : "RB",
    lights: dualSense ? "Square" : automatic ? "Square / X" : "X",
    signal: dualSense ? "Circle" : automatic ? "Circle / B" : "B",
    exit: dualSense ? "Options" : automatic ? "Options / Menu" : "Menu / Start"
  };
}
