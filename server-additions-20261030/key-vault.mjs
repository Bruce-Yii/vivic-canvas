import fs from 'node:fs';
import crypto from 'node:crypto';
export function openVault(file,entries=[]){
 let secret;
 try{
  if(fs.existsSync(file))secret=fs.readFileSync(file);
  else if(!entries.some(entry=>entry.encryptedKey)){
   secret=crypto.randomBytes(32);fs.writeFileSync(file,secret,{mode:0o600,flag:'wx'});
  }
 }catch{}
 if(secret?.length!==32)secret=undefined;
 return {
  ready:!!secret,
  seal(id,value){
   if(!secret)throw Error('Key vault unavailable');
   const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',secret,nonce);
   cipher.setAAD(Buffer.from(id));
   const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
   return {v:1,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  },
  reveal(id,envelope){
   if(!secret||envelope?.v!==1)throw Error('Key vault unavailable');
   const decipher=crypto.createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.nonce,'base64'));
   decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
   return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8');
  }
 };
}
