import type { Metadata } from "next";
import { LegalSection, LegalShell } from "../legal-page";

export const metadata: Metadata = {
  title: "Política de privacidad | 20Q Challenge",
  description: "Cómo 20Q Challenge trata datos de Riot y estadísticas de juego.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      eyebrow="Privacidad y RSO"
      title="Política de privacidad"
      summary="Esta política explica qué datos usa 20Q Challenge, por qué los usa y cómo cada jugador puede controlar su información."
    >
      <LegalSection title="1. Responsable y alcance">
        <p>
          20Q Challenge es un proyecto privado, gratuito y no comercial para comparar el progreso de un grupo de amigos en League of Legends. Esta política cubre el ranking, la futura conexión mediante Riot Sign On (RSO) y el análisis consentido de partidas personalizadas.
        </p>
      </LegalSection>

      <LegalSection title="2. Datos que utiliza el ranking">
        <p>Para los jugadores participantes podemos tratar:</p>
        <ul>
          <li>Riot ID, tagline, PUUID e icono de perfil.</li>
          <li>Rango, puntos de liga, victorias, derrotas y winrate.</li>
          <li>Estadísticas agregadas de partidas, como rol, KDA y campeones.</li>
          <li>Fechas técnicas de actualización y una copia de caché para evitar consultas excesivas a Riot.</li>
        </ul>
        <p>
          No solicitamos contraseñas de Riot, información de pago ni vendemos datos. La versión actual no utiliza cookies publicitarias ni almacena tokens RSO.
        </p>
      </LegalSection>

      <LegalSection title="3. Partidas personalizadas y consentimiento (opt-in)">
        <p>
          El acceso a partidas personalizadas se habilitará únicamente después de la aprobación de RSO. Cada jugador deberá iniciar sesión con Riot y autorizar expresamente el acceso. Los datos de una partida personalizada se mostrarán al propio jugador; solo se compartirán con el grupo o se harán visibles si ese jugador da un consentimiento específico para League of Legends.
        </p>
        <p>
          La app no usa estos datos para scouting, apuestas, publicidad dirigida ni ventajas en tiempo real. Un jugador puede revocar su consentimiento y solicitar la eliminación de sus datos.
        </p>
      </LegalSection>

      <LegalSection title="4. Finalidades y base del tratamiento">
        <ul>
          <li>Mostrar el ranking privado y estadísticas comprensibles.</li>
          <li>Verificar qué cuenta Riot autorizó el acceso mediante RSO.</li>
          <li>Analizar partidas personalizadas entre amigos cuando exista consentimiento.</li>
          <li>Proteger el servicio, diagnosticar errores y respetar los límites de la Riot API.</li>
        </ul>
        <p>
          La participación y el futuro acceso RSO se basan en el consentimiento del jugador. El tratamiento técnico mínimo se realiza para operar y proteger el servicio solicitado.
        </p>
      </LegalSection>

      <LegalSection title="5. Proveedores y transferencias">
        <p>
          Los datos provienen de Riot Games y se procesan mediante la Riot API. El Site se aloja mediante OpenAI Sites sobre infraestructura de Cloudflare. Estos proveedores pueden tratar datos técnicos necesarios para prestar sus servicios. No entregamos datos a anunciantes ni los comercializamos.
        </p>
      </LegalSection>

      <LegalSection title="6. Conservación y eliminación de datos">
        <p>
          La caché del ranking se actualiza periódicamente y reemplaza la información anterior. Los datos vinculados por RSO y las partidas personalizadas se conservarán solo mientras el jugador participe o sean necesarios para las funciones autorizadas. Las solicitudes de acceso, corrección, revocación o eliminación pueden enviarse al responsable de la aplicación mediante el registro de 20Q Challenge (Application ID 859508) en Riot Developer Portal.
        </p>
      </LegalSection>

      <LegalSection title="7. Seguridad y límites">
        <p>
          Las credenciales de Riot se mantienen del lado del servidor y no se publican en el navegador ni en el código del Site. Aplicamos HTTPS, validación de entradas y respuestas sin caché para rutas de autorización. Ningún sistema es infalible; si se detecta un incidente relevante se limitará el acceso y se informará a los jugadores afectados.
        </p>
      </LegalSection>

      <LegalSection title="8. Cambios">
        <p>
          Actualizaremos esta política antes de activar nuevas categorías de datos o cambios materiales en RSO. La fecha vigente se muestra al final de esta página.
        </p>
      </LegalSection>
    </LegalShell>
  );
}
