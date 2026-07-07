import fs from 'fs';
const DIR = process.argv[2];
const r6 = n => Math.round(n * 1e6) / 1e6;
function roadClass(hw){
  if(/^(motorway|trunk)(_link)?$/.test(hw))return 4;
  if(/^(primary)(_link)?$/.test(hw))return 3;
  if(/^(secondary|tertiary)(_link)?$/.test(hw))return 2;
  return 1;
}
function stitchRings(members){
  const outers=(members||[]).filter(m=>m.type==='way'&&m.geometry&&(m.role==='outer'||m.role===''||m.role==null));
  const segs=outers.map(m=>m.geometry.map(p=>[p.lat,p.lon]));
  const used=new Array(segs.length).fill(false);
  const key=p=>p[0].toFixed(6)+','+p[1].toFixed(6);
  const rings=[];
  for(let i=0;i<segs.length;i++){
    if(used[i])continue;used[i]=true;let ring=segs[i].slice();let guard=0;
    while(key(ring[0])!==key(ring[ring.length-1])&&guard++<segs.length+2){
      const tail=key(ring[ring.length-1]);let found=false;
      for(let j=0;j<segs.length;j++){if(used[j])continue;const s=segs[j];
        if(key(s[0])===tail){ring=ring.concat(s.slice(1));used[j]=true;found=true;break;}
        if(key(s[s.length-1])===tail){ring=ring.concat(s.slice().reverse().slice(1));used[j]=true;found=true;break;}}
      if(!found)break;
    }
    if(ring.length>=4)rings.push(ring);
  }
  return rings;
}
// decimate a ring to at most ~maxPts points
function decimate(ring,maxPts){
  if(ring.length<=maxPts)return ring.map(p=>[r6(p[0]),r6(p[1])]);
  const step=(ring.length-1)/(maxPts-1),out=[];
  for(let i=0;i<maxPts;i++)out.push(ring[Math.round(i*step)]);
  return out.map(p=>[r6(p[0]),r6(p[1])]);
}

const UA='streetCryptid-mockup/1.0 (design mockup)';
const EPS=[
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
async function overpass(q,cacheName){
  const cache=`${DIR}/${cacheName}`;
  if(fs.existsSync(cache))return JSON.parse(fs.readFileSync(cache,'utf8'));
  const body='data='+encodeURIComponent(q);
  for(let a=0;a<3;a++){
    for(const EP of EPS){
      try{const res=await fetch(EP,{method:'POST',headers:{'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded'},body});
        if(res.ok){const j=await res.json();fs.writeFileSync(cache,JSON.stringify(j));console.log('  ok via',EP);return j;}
        console.log('  round',a,EP.split('/')[2],'status',res.status);
      }catch(e){console.log('  round',a,EP.split('/')[2],'err',e.message);}
    }
    await new Promise(r=>setTimeout(r,6000*(a+1)));
  }
  throw new Error('fetch failed '+cacheName);
}

const OUT={};

// ---- CITY: Seattle arterials + water + city boundary (land shape) ----
try{
  const b='47.50,-122.44,47.74,-122.23';
  const q=`[out:json][timeout:180];(`+
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${b});`+
    `rel["natural"="water"](${b});`+
    `way["natural"="water"](${b});`+
    `rel["boundary"="administrative"]["admin_level"="8"]["name"="Seattle"](47.40,-122.55,47.80,-122.18);`+
    `);out body geom;`;
  const raw=await overpass(q,'raw_seattle.json');
  const ways=[],water=[],land=[];
  for(const el of raw.elements){
    const t=el.tags||{};
    if(el.type==='way'&&el.geometry){
      const g=el.geometry.map(p=>[r6(p.lat),r6(p.lon)]);
      if(t.highway)ways.push({k:'s',c:roadClass(t.highway),nm:t.name||'',g});
      else if(t.natural==='water'||t.water)water.push({g});
    }else if(el.type==='relation'&&t.natural==='water'){
      for(const rg of stitchRings(el.members))water.push({g:rg.map(p=>[r6(p[0]),r6(p[1])])});
    }else if(el.type==='relation'&&t.boundary==='administrative'){
      for(const rg of stitchRings(el.members))land.push({g:decimate(rg,900)});
    }
  }
  OUT.seattle={bbox:[47.50,-122.44,47.74,-122.23],ways,water,land};
  console.log('seattle  arterials',ways.length,'water',water.length,'landRings',land.length);
}catch(e){console.log('seattle FAILED',e.message);}

// ---- REGION: Washington state silhouette (hardcoded coarse outline — the admin_level=4
// relation is too heavy for any Overpass mirror; a ~25-pt silhouette reads fine at region zoom)
// ring is [lat,lon], clockwise from Cape Flattery (matches stitchRings output format)
const WA_OUTLINE=[
  [48.38,-124.73],[47.90,-124.65],[47.35,-124.35],[46.90,-124.10],[46.53,-124.05],
  [46.27,-124.08],[46.18,-123.72],[46.14,-123.20],[45.86,-122.81],[45.60,-122.70],
  [45.61,-121.98],[45.70,-121.13],[45.92,-120.63],[45.93,-119.60],[46.00,-118.98],
  [46.00,-116.92],[46.43,-116.96],[46.43,-117.04],[49.00,-117.04],[49.00,-123.05],
  [48.99,-122.75],[48.42,-122.90],[48.16,-123.20],[48.30,-124.10],[48.38,-124.73],
];
const WA_CITIES=[
  {name:'SEATTLE',lat:47.606,lon:-122.332,visited:1},
  {name:'BELLEVUE',lat:47.610,lon:-122.201,visited:1},
  {name:'EVERETT',lat:47.979,lon:-122.202,visited:1},
  {name:'TACOMA',lat:47.253,lon:-122.444,visited:1},
  {name:'OLYMPIA',lat:47.038,lon:-122.900,visited:0},
  {name:'BREMERTON',lat:47.567,lon:-122.632,visited:0},
  {name:'BELLINGHAM',lat:48.749,lon:-122.479,visited:0},
  {name:'WENATCHEE',lat:47.423,lon:-120.310,visited:0},
  {name:'YAKIMA',lat:46.602,lon:-120.505,visited:0},
  {name:'SPOKANE',lat:47.659,lon:-117.426,visited:0},
  {name:'TRI-CITIES',lat:46.235,lon:-119.220,visited:0},
  {name:'WALLA WALLA',lat:46.065,lon:-118.343,visited:0},
  {name:'PULLMAN',lat:46.731,lon:-117.180,visited:0},
  {name:'VANCOUVER',lat:45.639,lon:-122.661,visited:0},
  {name:'PORT ANGELES',lat:48.118,lon:-123.430,visited:0},
];
try{
  OUT.washington={bbox:[45.45,-124.85,49.05,-116.90],land:[{g:WA_OUTLINE}],cities:WA_CITIES};
  console.log('washington (hardcoded outline) pts',WA_OUTLINE.length,'cities',WA_CITIES.length);
}catch(e){console.log('washington FAILED',e.message);OUT.washington={bbox:[45.45,-124.85,49.05,-116.90],land:[],cities:WA_CITIES};}

fs.writeFileSync(`${DIR}/zoomdata.js`,'window.OSMZOOM='+JSON.stringify(OUT)+';');
console.log('wrote zoomdata.js',Math.round(fs.statSync(`${DIR}/zoomdata.js`).size/1024)+'kb');
