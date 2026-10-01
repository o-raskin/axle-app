# Measured Tumbler wheel movement

The previous viewer used an arbitrary full-power rotation rate of 5.5 rad/s. A
power command cannot identify physical wheel speed under load, during boost, or
when a wheel stalls. The viewer now consumes cumulative measured drivetrain
travel instead.

## Source and conversion

The saved Technic Move hub probe reports ports 0x32/0x33 with readable input
mode 2 `POS`, unit `DEG`, and one signed 32-bit dataset. `SPEED` mode 1 is an
output mode, so it cannot be treated as measured RPM. Startup discovers the
actual input mode, name, unit, value format, and RAW/SI ranges before subscribing.
It occurs after the existing PLAYVM steering calibration and issues no additional
motor output commands.

The [official 42239 instructions](https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6675742.pdf)
establish the conversion:

- Printed page 82, step 77: equal 16-tooth gears on both motor output shafts.
- Page 87, step 85: the central 16-tooth gear shares a shaft with a 14-tooth gear.
- Pages 88–89, steps 86–87: that gear drives the 22-tooth differential carrier.
- Page 90, step 88: rear hubs connect directly to differential output shafts.

Mean rear-wheel travel is therefore `(16/16) × (14/22) = 7/11` of normalized
motor shaft travel. These two motor encoders observe one shared drivetrain,
not independent left/right wheels. The rendered rear pairs share this measured
mean, and front tires use `68.7/56` to represent normal rolling. Differential
wheel differences during cornering or slipping and independently slipping front
tires cannot be measured by this hub.

Native encoder polarity is not established by the port names. The bridge learns
it passively during an ordinary drive. When a stationary baseline is available,
it uses at least 100 ms of stationary encoder evidence before the drive command,
250 ms of stable command direction, and two consistent rotation samples per
encoder. If encoder discovery finishes after the first trigger press, the first
paired encoder sample becomes the baseline and the same stable-motion evidence
learns polarity without estimating speed from the trigger. It does not move the
car to calibrate. External movement forced against the command cannot be
identified.
Once learned, signs persist for the session and throttle never determines speed.

## Transport and rendering

The [LEGO Wireless Protocol](https://lego.github.io/lego-ble-wireless-protocol-docs/)
defines input mode acknowledgements (0x47), standard input values (0x45), and
current-value requests (0x21, information type 0). Values have no mode byte, so
the bridge caches them with the acknowledged mode and monotonic receipt time.
That cache survives notification drains used by PLAYVM impact handling.

Position change notifications use a nonzero delta threshold of 10 raw units;
that threshold is a value change, not a sampling period. Read-only polling every
100 ms also reports stationary positions, avoiding false continuing movement
at a stall. RAW/SI scaling and signed 32-bit wrap are applied before converting
to cumulative wheel radians. Paired samples expire after 300 ms and must arrive
within 50 ms of each other. Discovery or reading failures pause wheel animation
without disabling driving. Optional encoder writes have a 400 ms deadline so an
unresponsive read cannot leave the control loop waiting indefinitely. Brief
incomplete pairs preserve established rest and direction-learning evidence until
the last confirmed pair expires.

The frontend receives positions at up to 10 Hz (the bridge publishes every 100 ms) and interpolates actual samples
with a 120 ms presentation delay. It never extrapolates beyond the last observed
position. The viewer expires samples after 600 ms of total measurement and delivery
age; the bridge still rejects encoder pairs older than 300 ms. Session changes, missing feedback, hidden views and reduced motion
establish a new origin rather than replaying missed travel. Braking and impact
commands do not overwrite real residual movement from the encoders.

Automated tests cover protocol decoding, unchanged PLAYVM startup and impact
handling, gearing and passive direction learning, stalls/coasting/reversal,
frame-rate independence and actual rendered wheel rates in an isolated Electron
window. End-to-end operation with a physical Technic Move hub remains unverified.
