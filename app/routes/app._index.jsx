import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  List,
  Banner,
  InlineStack,
  Button,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  // Forza la registrazione dei Webhook per il pilota automatico
  try {
    const { registerWebhooks } = await import("../shopify.server");
    await registerWebhooks({ session });
  } catch (e) {
    console.error("Errore registrazione webhooks:", e);
  }

  // CONTROLLO CONFIGURAZIONE CAMPI (Metafield Definitions)
  const defsResponse = await admin.graphql(
    `#graphql
    query getDefinitions {
      metafieldDefinitions(first: 20, ownerType: PRODUCT) {
        nodes { namespace key }
      }
    }`
  );
  const defsData = await defsResponse.json();
  const defs = defsData.data?.metafieldDefinitions?.nodes || [];
  
  const hasWidth = defs.some(d => d.namespace === "pod" && d.key === "width");
  const hasHeight = defs.some(d => d.namespace === "pod" && d.key === "height");
  const hasSvg = defs.some(d => d.namespace === "pod" && d.key === "svg");
  const hasUrl = defs.some(d => d.namespace === "custom" && d.key === "pod_svg_url");
  
  const isConfigured = hasWidth && hasHeight && hasSvg && hasUrl;

  const response = await admin.graphql(
    `#graphql
    query getOrderStats {
      orders(first: 50, query: "fulfillment_status:unfulfilled") {
        nodes {
          printed: metafield(namespace: "pod", key: "printed") { value }
          lineItems(first: 10) {
            nodes {
              product {
                metafields(first: 5, namespace: "pod") {
                  nodes {
                    key
                    value
                    reference {
                      ... on GenericFile { url }
                      ... on MediaImage { image { url } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
  );

  const data = await response.json();
  const allOrders = data.data?.orders?.nodes || [];

  const podOrders = allOrders.filter(order => {
    return order.lineItems?.nodes?.some(item => {
      const metafields = item.product?.metafields?.nodes || [];
      return metafields.some(m => m.key === "svg" && (m.value || m.reference));
    }) || false;
  });

  const pending = podOrders.filter(o => o.printed?.value !== "true").length;
  const printed = podOrders.filter(o => o.printed?.value === "true").length;

  return json({ pending, printed, isConfigured });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const type = formData.get("type");

  if (type === "setup") {
    const definitions = [
      { namespace: "pod", key: "width", name: "POD Width", type: "number_decimal", ownerType: "PRODUCT" },
      { namespace: "pod", key: "height", name: "POD Height", type: "number_decimal", ownerType: "PRODUCT" },
      { namespace: "pod", key: "svg", name: "POD SVG File", type: "file_reference", ownerType: "PRODUCT" },
      { namespace: "custom", key: "pod_svg_url", name: "POD SVG URL", type: "single_line_text_field", ownerType: "PRODUCT" },
      { namespace: "pod", key: "printed", name: "POD Printed", type: "boolean", ownerType: "ORDER" },
      { namespace: "pod", key: "status", name: "POD Approval Status", type: "single_line_text_field", ownerType: "ORDER" }
    ];

    for (const def of definitions) {
      await admin.graphql(
        `#graphql
        mutation createMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            definition: {
              namespace: def.namespace,
              key: def.key,
              name: def.name,
              type: def.type,
              ownerType: def.ownerType
            }
          }
        }
      );
    }
    return json({ success: true });
  }
  return null;
};

export default function Index() {
  const { pending, printed, isConfigured } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  return (
    <Page>
      <TitleBar title="POD-Generator Dashboard" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!isConfigured && (
              <Banner title="Configurazione Iniziale" tone="warning" 
                      action={{content: "Configura Campi POD", onClick: () => fetcher.submit({type: "setup"}, {method: "POST"}), loading: fetcher.state !== "idle"}}>
                <p>Alcuni campi necessari per il funzionamento (Dimensioni, URL SVG) non sono ancora presenti in questo negozio.</p>
              </Banner>
            )}

            {fetcher.data?.success && (
              <Banner title="Configurazione Completata!" tone="success">
                <p>Tutti i campi sono stati creati con successo. Ora puoi iniziare a gestire le grafiche.</p>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Benvenuto nel tuo sistema Print on Demand! 🎉
                </Text>
                <Text variant="bodyMd" as="p">
                  Gestione automatica delle grafiche DTF e impaginazione intelligente.
                </Text>
              </BlockStack>
            </Card>

            <InlineStack gap="400">
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="brand">{pending}</Text>
                    <Text variant="bodyMd" tone="subdued">Da Stampare</Text>
                    <Button variant="primary" onClick={() => navigate("/app/orders")}>Ordini</Button>
                  </BlockStack>
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="success">{printed}</Text>
                    <Text variant="bodyMd" tone="subdued">Stampati</Text>
                    <Button variant="plain" disabled>Statistiche</Button>
                  </BlockStack>
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="caution">🎨</Text>
                    <Text variant="bodyMd" tone="subdued">Grafiche & Anteprime</Text>
                    <Button onClick={() => navigate("/app/catalog")}>Catalogo</Button>
                  </BlockStack>
                </Card>
              </div>
            </InlineStack>

            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" as="h3">Come iniziare:</Text>
                <List>
                  <List.Item>
                    Importa il CSV con i dati POD (Dimensioni e URL).
                  </List.Item>
                  <List.Item>
                    Entra nella pagina di un <strong>Prodotto</strong> su Shopify per verificare che i campi siano pieni.
                  </List.Item>
                </List>
                
                <Banner tone="info">
                  L'app caricherà i PDF in automatico prendendoli dai link esterni se il file locale non è presente.
                </Banner>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
