import type { Metadata } from "next";
import { LegalSection, LegalShell } from "../legal-page";

export const metadata: Metadata = {
  title: "Términos del servicio | 20Q Challenge",
  description: "Condiciones de uso de 20Q Challenge y su futura integración con Riot Sign On.",
};

export default function TermsPage() {
  return (
    <LegalShell
      eyebrow="Condiciones de uso"
      title="Términos del servicio"
      summary="Estas condiciones regulan el uso del ranking y de las funciones que conecten una cuenta de Riot con 20Q Challenge."
    >
      <LegalSection title="1. Aceptación y finalidad">
        <p>
          Al utilizar 20Q Challenge aceptas estos términos y la Política de privacidad. El servicio es un proyecto gratuito y no comercial para un grupo de amigos; muestra progreso de SoloQ y, cuando Riot lo autorice, permitirá consultar partidas personalizadas con consentimiento.
        </p>
      </LegalSection>

      <LegalSection title="2. Participación y conexión con Riot">
        <p>
          Solo debes vincular una cuenta de Riot que te pertenezca. La autorización mediante Riot Sign On es voluntaria y puede revocarse. No debes compartir contraseñas, códigos de autorización ni credenciales con 20Q Challenge o con otros participantes.
        </p>
      </LegalSection>

      <LegalSection title="3. Partidas personalizadas y visibilidad">
        <p>
          Los datos de partidas personalizadas se usarán para que los amigos participantes revisen sus propias partidas y estadísticas. No publicaremos el historial personalizado de un jugador sin su opt-in específico para League of Legends. El servicio no se utilizará para scouting, apuestas, acoso ni para obtener ventajas en tiempo real.
        </p>
      </LegalSection>

      <LegalSection title="4. Uso permitido">
        <ul>
          <li>Consultar el ranking y estadísticas del grupo de buena fe.</li>
          <li>Autorizar únicamente datos propios y respetar la privacidad de los demás.</li>
          <li>No automatizar consultas abusivas ni intentar eludir límites de Riot.</li>
          <li>No explotar errores, acceder a cuentas ajenas ni alterar el servicio.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Disponibilidad y cambios">
        <p>
          El servicio se ofrece tal cual, puede contener datos retrasados y depende de Riot Games, la Riot API y proveedores de alojamiento. Podemos corregir, suspender o retirar funciones para proteger a los jugadores, cumplir políticas o responder a cambios de Riot.
        </p>
      </LegalSection>

      <LegalSection title="6. Propiedad intelectual y Riot Games">
        <p>
          Los nombres, marcas, recursos y datos de League of Legends pertenecen a Riot Games o a sus respectivos titulares. El contenido propio y la presentación de 20Q Challenge no otorgan derechos sobre esos materiales.
        </p>
        <blockquote>
          20Q Challenge isn&apos;t endorsed by Riot Games and doesn&apos;t reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
        </blockquote>
      </LegalSection>

      <LegalSection title="7. Privacidad, eliminación y suspensión">
        <p>
          El tratamiento de datos se describe en la Política de privacidad. Un jugador puede revocar su participación o solicitar eliminación. También podemos suspender acceso cuando exista abuso, riesgo para otras cuentas o incumplimiento de estos términos o de las políticas de Riot.
        </p>
      </LegalSection>

      <LegalSection title="8. Contacto y actualizaciones">
        <p>
          Las consultas sobre el servicio pueden dirigirse al responsable mediante el registro de 20Q Challenge (Application ID 859508) en Riot Developer Portal. Los cambios materiales se publicarán aquí antes de entrar en vigor.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
