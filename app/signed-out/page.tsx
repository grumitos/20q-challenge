import type { Metadata } from "next";
import Link from "next/link";
import { LegalSection, LegalShell } from "../legal-page";

export const metadata: Metadata = {
  title: "Sesión cerrada | 20Q Challenge",
  description: "Confirmación de cierre de sesión de Riot para 20Q Challenge.",
};

export default function SignedOutPage() {
  return (
    <LegalShell
      eyebrow="Riot Sign On"
      title="Sesión de Riot cerrada"
      summary="La sesión de autorización terminó y puedes cerrar esta pestaña con seguridad."
    >
      <LegalSection title="Tu cuenta sigue bajo tu control">
        <p>
          20Q Challenge no recibe tu contraseña de Riot. Si quieres retirar por completo un permiso concedido previamente, también puedes revocarlo desde las opciones de tu cuenta Riot.
        </p>
        <p><Link className="legal-action" href="/">Volver al ranking</Link></p>
      </LegalSection>
    </LegalShell>
  );
}
