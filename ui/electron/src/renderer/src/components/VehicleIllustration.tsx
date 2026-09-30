import { useId } from "react";

/** An original, decorative mechanical model; no product artwork is used. */
export function VehicleIllustration({ connected = false }: { connected?: boolean }) {
  const id = useId().replace(/:/g, "");
  const paint = `${id}-paint`;
  const tire = `${id}-tire`;
  const metal = `${id}-metal`;
  const wheel = `${id}-wheel`;
  const shadow = `${id}-shadow`;

  return (
    <svg
      className="vehicle-illustration"
      viewBox="0 0 680 340"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={paint} x1="300" y1="90" x2="450" y2="240" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F6A75C" />
          <stop offset="1" stopColor="#D86A37" />
        </linearGradient>
        <linearGradient id={metal} x1="248" y1="106" x2="365" y2="246" gradientUnits="userSpaceOnUse">
          <stop stopColor="#73776E" />
          <stop offset="1" stopColor="#353C37" />
        </linearGradient>
        <linearGradient id={tire} x1="-34" y1="-42" x2="38" y2="49" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B413A" />
          <stop offset="0.48" stopColor="#242A25" />
          <stop offset="1" stopColor="#101612" />
        </linearGradient>
        <filter id={shadow} x="-30%" y="-100%" width="160%" height="300%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <g id={wheel}>
          <ellipse cx="14" cy="-7" rx="43" ry="50" fill="#171D18" stroke="#41483E" strokeWidth="2" />
          <path d="M-27-35  -13-45M-16-45-2-54M0-49 14-57M17-47 31-54M31-37 45-44M39-22 53-29M42-5 56-12M40 13 54 6M32 30 46 23M17 43 31 36M0 49 14 42M-18 44-4 37M-31 32-17 25" stroke="#4B5147" strokeWidth="5" />
          <ellipse rx="43" ry="50" fill={`url(#${tire})`} stroke="#51574C" strokeWidth="1.5" />
          {Array.from({ length: 16 }, (_, index) => {
            const angle = (index * Math.PI) / 8;
            return <path key={index} d={`M ${Math.cos(angle) * 36} ${Math.sin(angle) * 43} L ${Math.cos(angle) * 41} ${Math.sin(angle) * 48}`} stroke="#596052" strokeWidth="3" />;
          })}
          <ellipse rx="28" ry="34" fill="#111813" stroke="#535C4D" strokeWidth="2" />
          <ellipse rx="22" ry="28" fill="#535A4B" stroke="#777D68" />
          <path d="M-4-24 3-24 5-8-3-8ZM15-16 19-9 8 0 3-5ZM19 10 15 17 2 7 6 1ZM3 23-4 23-4 8 3 8ZM-18 15-21 7-8 0-4 6ZM-19-11-14-19-3-7-8-1Z" fill="#242D24" />
          <ellipse rx="9" ry="11" fill="#858A72" stroke="#ADB098" strokeWidth="1.2" />
          <ellipse rx="3" ry="4" fill="#252D25" />
        </g>
      </defs>

      {/* A quiet drafting grid keeps the model grounded without framing it. */}
      <g stroke="#B1B7A4" strokeWidth="0.7" opacity="0.11">
        <path d="M119 249 398 308 601 200M148 230 427 289 623 186M178 211 456 270 631 177M212 191 485 251 612 176" />
        <path d="M147 254 322 142M210 267 385 155M273 281 448 168M336 294 511 181M399 306 574 194" />
      </g>
      <ellipse cx="380" cy="278" rx="218" ry="24" fill="#0C120D" opacity="0.7" filter={`url(#${shadow})`} />

      {/* The two distant wheels sit behind the exposed suspension. */}
      <use href={`#${wheel}`} transform="translate(326 169) rotate(11) scale(.78)" />
      <use href={`#${wheel}`} transform="translate(543 190) rotate(11) scale(.85)" />
      <path d="M239 222 329 167 543 194 453 253Z" fill="#202720" stroke="#7F8575" strokeWidth="3" />
      <path d="M229 226 335 169M446 253 551 191" stroke="#959B80" strokeWidth="7" />
      <path d="M230 225 335 169M447 252 551 191" stroke="#353E31" strokeWidth="3" />
      <path d="M264 193 451 228M310 171 499 206" stroke="#56614C" strokeWidth="10" />

      {/* Chassis rails with visible pin holes. */}
      <path d="M180 191 219 179 543 214 515 238 192 213Z" fill="#424B3C" stroke="#737B64" strokeWidth="1.5" />
      <path d="M194 199 510 228" stroke="#222B22" strokeWidth="12" strokeLinecap="round" />
      <g fill="#7F866D" stroke="#151F16" strokeWidth="3">
        {[215, 245, 275, 305, 335, 365, 395, 425, 455, 485].map((x) => (
          <ellipse key={x} cx={x} cy={201 + (x - 215) * 0.092} rx="4" ry="4.5" />
        ))}
      </g>
      <path d="M198 182 316 117 547 161 554 195 510 222 398 208Z" fill="#2B342A" stroke="#5F6A54" strokeWidth="2" />
      <path d="M253 181 325 136 439 159 370 199Z" fill="#151E18" />

      {/* Orange side panels and sloping hood. */}
      <path d="M193 180 244 151 323 166 284 200 199 192Z" fill={`url(#${paint})`} stroke="#FEBD79" strokeWidth="1.3" />
      <path d="M199 192 284 200 282 212 204 204Z" fill="#AD512F" />
      <path d="M333 187 382 157 481 175 521 205 482 228 378 212Z" fill={`url(#${paint})`} stroke="#FDB57A" strokeWidth="1.3" />
      <path d="M379 212 483 228 479 239 377 223 342 204 333 187Z" fill="#B85833" stroke="#DE8248" />
      <path d="M382 157 449 119 526 134 548 165 481 175Z" fill="#F0A15C" stroke="#FFC58A" strokeWidth="1.3" />
      <path d="M481 175 548 165 558 184 521 205Z" fill="#D47640" stroke="#ED9A61" />
      <path d="M401 157 448 131 506 142 472 166Z" fill="#414A39" stroke="#697258" />
      <path d="M415 154 450 135 493 143 469 160Z" fill="#222D24" />
      <g stroke="#8B9479" strokeWidth="2">
        <path d="m436 145 39 8m-45-4 39 8m-45-4 39 8" />
      </g>
      <path d="M358 198 384 183 433 192 407 207Z" fill="#263125" />
      <path d="M368 198 385 189 419 195 406 202Z" fill="#151E17" />
      <circle cx="345" cy="193" r="3" fill="#753E28" />
      <circle cx="462" cy="223" r="3" fill="#753E28" />
      <circle cx="214" cy="189" r="3" fill="#753E28" />
      <circle cx="277" cy="193" r="3" fill="#753E28" />

      {/* Open cockpit and roll cage show the mechanical construction. */}
      <path d="M264 162 286 110 353 84 429 105 443 142 375 182Z" fill="#242E25" stroke="#7B8470" strokeWidth="2" />
      <path d="M278 155 294 116 357 93 415 110 426 139 373 170Z" fill="#131D17" />
      <path d="M286 110 353 84 429 105 362 135Z" fill={`url(#${metal})`} stroke="#A1A78C" strokeWidth="1.5" />
      <path d="M300 111 351 92 408 107 359 125Z" fill="#D7894D" />
      <path d="m307 112 45-15 45 10-40 13Z" fill="#F1A660" />
      <path d="M267 165 288 113 362 135 375 182M362 135 429 106" stroke="#7C866C" strokeWidth="8" strokeLinejoin="round" />
      <path d="M267 165 288 113 362 135 375 182M362 135 429 106" stroke="#B0B49A" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M288 115 343 179M271 158 357 139" stroke="#505C48" strokeWidth="4" />
      <path d="m321 151 22-11 9 24-20 12Z" fill="#3F4E3B" stroke="#66785B" strokeWidth="2" />
      <path d="m324 170 12 6 24-13" stroke="#899B74" strokeWidth="4" />
      <path d="M388 146 398 157" stroke="#859278" strokeWidth="4" />
      <ellipse cx="387" cy="146" rx="10" ry="4" transform="rotate(-28 387 146)" stroke="#AAB195" strokeWidth="3" />
      <path d="M285 104 353 77 436 100 428 108 352 89 289 114Z" fill="#606B56" stroke="#A8AD94" />
      <path d="m316 94 16-6 58 16-14 6Z" fill="#CED0B6" opacity="0.55" />

      {/* Exposed springs and front bumper. */}
      <path d="m233 199 14 35m223-23-13 37" stroke="#222C21" strokeWidth="9" />
      <path d="m231 204 13-4-8 13 13-4-8 13 13-4-8 13m217-12-11-5 6 13-11-4 6 13-11-4" stroke="#D8C9A2" strokeWidth="3" strokeLinejoin="round" />
      <path d="M516 210 558 185 579 190 583 203 536 230 517 225Z" fill="#273225" stroke="#8B9479" strokeWidth="3" strokeLinejoin="round" />
      <path d="m536 218 33-19" stroke="#121D16" strokeWidth="7" strokeLinecap="round" />
      <path d="M527 184 541 176 550 179 536 187Z" fill={connected ? "#DFF1B9" : "#CFD1AA"} />
      <path d="M494 202 507 194 516 197 503 205Z" fill={connected ? "#DFF1B9" : "#CFD1AA"} />
      <path d="M185 179 214 163 222 169 191 187Z" fill="#3F4A39" stroke="#858D74" strokeWidth="2" />
      <path d="M198 172 198 149 258 117 272 120 214 153 214 164" fill="#333E30" stroke="#7E876D" strokeWidth="3" />
      <path d="M188 145 253 108 278 114 215 152Z" fill="#677357" stroke="#A8B093" strokeWidth="1.5" />
      <path d="m206 140 44-25 10 2-44 25Z" fill="#939C7C" />

      {/* Foreground wheels complete the three-quarter silhouette. */}
      <use href={`#${wheel}`} transform="translate(226 236) rotate(11)" />
      <use href={`#${wheel}`} transform="translate(453 260) rotate(11) scale(1.08)" />
      <path d="M192 197 214 185 241 187 263 200" stroke="#8B9277" strokeWidth="5" strokeLinecap="round" />
      <path d="M415 216 436 203 464 206 489 224" stroke="#8B9277" strokeWidth="5" strokeLinecap="round" />
      <g fill="#D1D4B7">
        <circle cx="216" cy="189" r="2" />
        <circle cx="241" cy="192" r="2" />
        <circle cx="439" cy="209" r="2" />
        <circle cx="463" cy="212" r="2" />
      </g>
    </svg>
  );
}
