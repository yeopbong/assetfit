import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
export async function compareModels(elements,urls,{cameraSpec,onCamera}={}){
 const panes=[];let dead=false,syncing=false,frame,observer;
 const cleanup=()=>{dead=true;cancelAnimationFrame(frame);observer?.disconnect();for(const p of panes){p.controls.dispose();p.scene.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of [].concat(o.material)){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose();}});p.renderer.dispose();p.renderer.forceContextLoss();}};
 try{for(let i=0;i<elements.length;i++){
  const el=elements[i],renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;el.appendChild(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.001,10000),controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
  const ambient=new THREE.HemisphereLight(0xffffff,0x536074,2),key=new THREE.DirectionalLight(0xffffff,3);key.position.set(3,5,4);const fill=new THREE.DirectionalLight(0xb8d3ff,1);fill.position.set(-3,2,-4);scene.add(ambient,key,fill);
  const pane={renderer,scene,camera,controls,el,lights:[ambient,key,fill]};panes.push(pane);
  const gltf=await new GLTFLoader().loadAsync(urls[i]);if(dead){gltf.scene.traverse(o=>o.geometry?.dispose());return cleanup;}scene.add(gltf.scene);
  if(i===0){const box=new THREE.Box3().setFromObject(gltf.scene),sphere=box.getBoundingSphere(new THREE.Sphere());const c=sphere.center,r=sphere.radius||1;const spec=cameraSpec??{position:[c.x+r*2.6,c.y+r*1.3,c.z+r*2.6],target:c.toArray()};camera.fov=spec.fov??35;camera.position.fromArray(spec.position);controls.target.fromArray(spec.target??c.toArray());camera.near=Math.max(r/1000,.00001);camera.far=r*100;camera.updateProjectionMatrix();}
  else {camera.copy(panes[0].camera);controls.target.copy(panes[0].controls.target);}controls.update();
  controls.addEventListener('change',()=>{if(syncing)return;syncing=true;for(const p of panes)if(p!==pane){p.camera.position.copy(camera.position);p.camera.quaternion.copy(camera.quaternion);p.controls.target.copy(controls.target);p.controls.update();}onCamera?.({position:camera.position.toArray(),target:controls.target.toArray()});syncing=false;});
 }
 onCamera?.({position:panes[0].camera.position.toArray(),target:panes[0].controls.target.toArray(),fov:panes[0].camera.fov});
 const resize=()=>{for(const p of panes){const w=p.el.clientWidth,h=p.el.clientHeight;p.renderer.setSize(w,h,false);p.camera.aspect=w/h;p.camera.updateProjectionMatrix();}};observer=new ResizeObserver(resize);elements.forEach(el=>observer.observe(el));resize();const draw=()=>{if(dead)return;for(const p of panes){p.controls.update();p.renderer.render(p.scene,p.camera);}frame=requestAnimationFrame(draw);};draw();
 return {dispose:cleanup,setLight:value=>panes.forEach(p=>p.lights.forEach((light,i)=>light.intensity=Number(value)*[2,3,1][i]))};
 }catch(e){cleanup();throw e;}
}
