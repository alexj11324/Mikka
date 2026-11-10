import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { z } from 'zod'

export const samlSpSigningInput = z.object({
  cert: z.string().max(12000), privateKey: z.string().min(1).max(20000), passphrase: z.string().max(4096).optional(),
}).strict().refine(value => {
  try {
    const certificate = new X509Certificate(value.cert)
    const key = createPrivateKey({ key: value.privateKey, ...(value.passphrase ? { passphrase: value.passphrase } : {}) })
    return key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      && Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now()
      && createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  } catch { return false }
}, { message: 'A current RSA certificate and its matching private key are required' })

const xml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)

/** Only public certificate material enters metadata; the private key stays in the encrypted config. */
export function samlSpMetadata(input: { issuer: string; acsUrl: string; sloUrl: string; signing: z.infer<typeof samlSpSigningInput> }) {
  const signing = samlSpSigningInput.parse(input.signing)
  const certificate = new X509Certificate(signing.cert).raw.toString('base64')
  return `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${xml(input.issuer)}"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="true" WantAssertionsSigned="true"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xml(input.sloUrl)}"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${xml(input.sloUrl)}"/><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xml(input.acsUrl)}" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor>`
}
