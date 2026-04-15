import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Checkbox,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { PDFDocument, rgb } from "pdf-lib";
// import { generatePodPdf } from "../lib/pod.server";

export const loader = async ({ request }) => {
  // CLEAN UI RESTORED - FINAL BUILD
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const downloadIds = url.searchParams.get("download");

  // Loader pulito - Restituisce gli ordini per la tabella

  // Normal loader logic...
  const response = await admin.graphql(
    `#graphql
    query getOrders {
      orders(first: 100, query: "status:open fulfillment_status:unfulfilled") {
        nodes {
          id
          name
          createdAt
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          tags
          printed: metafield(namespace: "pod", key: "printed") { value }
          approved: metafield(namespace: "pod", key: "status") { value }
          lineItems(first: 20) {
            nodes {
              id
              title
              customAttributes { key value }
              product {
                id
                metafields(first: 50) {
                  nodes {
                    namespace
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
    // Check if it's a Zepto order via tag
    const isZepto = order.tags?.includes("product-personalizer");
    
    // Check if it's a standard POD order via SVG metafield or URL
    const hasPodProduct = order.lineItems.nodes.some(item => {
      const metafields = item.product?.metafields?.nodes || [];
      const hasSvg = metafields.some(m => m.namespace === "pod" && m.key === "svg" && (m.value || m.reference));
      const hasUrl = metafields.some(m => m.namespace === "custom" && m.key === "pod_svg_url" && m.value);
      return hasSvg || hasUrl;
    });

    return isZepto || hasPodProduct;
  });

  return json({ orders: podOrders });
};

export const action = async ({ request }) => {
  console.log("--- INIZIO AZIONE DOWNLOAD PDF ---");
  const { admin, session } = await authenticate.admin(request);
  console.log("Autenticazione riuscita per shop:", session.shop);

  const formData = await request.formData();
  const type = formData.get("type");

  if (type === "generatePdf") {
    try {
      const selectedIds = JSON.parse(formData.get("orderIds"));
      
      // 1. FETCH TUTTI GLI ORDINI IN UN'UNICA RICHIESTA (BATCHING)
      const response = await admin.graphql(
        `#graphql
        query getBatchOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              tags
              status: metafield(namespace: "pod", key: "status") { value }
              lineItems(first: 20) {
                nodes {
                  id
                  title
                  quantity
                  product {
                    metafields(first: 50) {
                      nodes {
                        namespace
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
        }`,
        { variables: { ids: selectedIds } }
      );
      const batchRes = await response.json();
      const ordersDetails = batchRes.data?.nodes || [];

      const itemsToPack = [];
      const svgCache = new Map(); // CACHE PER NON SCARICARE DOPPIONI

      for (const order of ordersDetails) {
        if (!order) continue;
        
        // Verifica approvazione Zepto
        const isZepto = order.tags?.includes("product-personalizer");
        if (isZepto && order.status?.value !== "approved") {
          throw new Error(`Ordine ${order.name} non approvato.`);
        }

        for (const item of order.lineItems.nodes) {
          const metafields = item.product?.metafields?.nodes || [];
          const widthVal = metafields.find(m => (m.namespace === "pod" || !m.namespace) && m.key === "width")?.value;
          const heightVal = metafields.find(m => (m.namespace === "pod" || !m.namespace) && m.key === "height")?.value;
          
          if (widthVal && heightVal) {
            const svgMeta = metafields.find(m => m.namespace === "pod" && m.key === "svg");
            const svgTextUrl = metafields.find(m => m.namespace === "custom" && m.key === "pod_svg_url")?.value;
            let svgUrl = svgTextUrl || svgMeta?.reference?.url || svgMeta?.reference?.image?.url;

            if (svgUrl) {
              // ASSICURA HTTPS PER I LINK CDN
              if (svgUrl.startsWith("//")) svgUrl = "https:" + svgUrl;

              let svgContent = svgCache.get(svgUrl);
              
              if (!svgContent) {
                console.log(`PDF: Download grafico da: ${svgUrl}`);
                try {
                  const svgRes = await fetch(svgUrl);
                  if (svgRes.ok) {
                    svgContent = await svgRes.text();
                    svgCache.set(svgUrl, svgContent);
                  } else {
                    console.error(`Errore download (${svgRes.status}) per: ${svgUrl}`);
                  }
                } catch (fetchErr) {
                  console.error(`Errore fetch grafico per ${item.id}:`, fetchErr.message);
                }
              }

              if (svgContent) {
                for (let i = 0; i < item.quantity; i++) {
                  itemsToPack.push({
                    id: `${item.id}-${i}`,
                    orderName: order.name,
                    widthMm: parseFloat(widthVal),
                    heightMm: parseFloat(heightVal),
                    svgContent: svgContent
                  });
                }
              }
            }
          }
        }
      }


      if (itemsToPack.length > 0) {
        const { generatePodPdf } = await import("../lib/pod.server");
        const pdfBuffer = await generatePodPdf(itemsToPack);
        
        // AUTO-MARK AS PRINTED
        for (const id of selectedIds) {
          await admin.graphql(
            `#graphql
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id value }
              }
            }`,
            {
              variables: {
                metafields: [
                  {
                    ownerId: id,
                    namespace: "pod",
                    key: "printed",
                    value: "true",
                    type: "boolean"
                  }
                ]
              }
            }
          );
        }

        return json({ 
          success: true, 
          pdfBase64: pdfBuffer.toString("base64"),
          fileName: `STAMPA_POD_${new Date().getTime()}.pdf`
        });
      } else {
        return json({ error: "Nessuna grafica trovata (Verifica Width/Height)." }, { status: 400 });
      }
    } catch (err) {
      console.error("ERRORE GENERAZIONE:", err);
      return json({ error: "Errore durante la creazione del PDF: " + err.message }, { status: 500 });
    }
  }

  if (type === "markAsPrinted") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value") || "true";
    console.log(`--- SEGNANDO COME ${value.toUpperCase()}:`, orderIds);
    for (const id of orderIds) {
      const response = await admin.graphql(
        `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "pod",
                key: "printed",
                value: value,
                type: "boolean"
              }
            ]
          }
        }
      );
      const resData = await response.json();
      console.log(`Risultato per ${id}:`, JSON.stringify(resData.data?.metafieldsSet));
    }
    return json({ success: true });
  }

  if (type === "markAsApproved") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value") || "approved";
    for (const id of orderIds) {
      await admin.graphql(
        `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "pod",
                key: "status",
                value: value,
                type: "single_line_text_field"
              }
            ]
          }
        }
      );
    }
    return json({ success: true });
  }

  if (type === "updateMetafield") {
    const productId = formData.get("productId");
    const key = formData.get("key");
    const value = formData.get("value");

    const response = await admin.graphql(
      `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: "pod",
              key: key,
              value: value,
              type: "number_decimal"
            }
          ]
        }
      }
    );
    const res = await response.json();
    console.log("Metafield aggiornato:", JSON.stringify(res.data?.metafieldsSet));
    return json(res);
  }

  return json({ error: "Invalid action type" }, { status: 400 });
}

export default function Orders() {
  const { orders } = useLoaderData();
  const shopify = useAppBridge();
  const [selectedItems, setSelectedItems] = useState([]);
  const fetcher = useFetcher();

  const handleGenerate = async () => {
    window.shopify?.loading(true);
    const formData = new FormData();
    formData.append("type", "generatePdf");
    formData.append("orderIds", JSON.stringify(selectedItems));
    fetcher.submit(formData, { method: "POST" });
  };

  // Check for fetcher response
  const actionData = fetcher.data;

  if (actionData?.diagnostic && typeof window !== "undefined") {
    alert(`DIAGNOSTIC: ${actionData.message}`);
    window.shopify?.loading(false);
  }

  if (actionData?.error && typeof window !== "undefined") {
    alert(`ERRORE SERVER: ${actionData.error}`);
    window.shopify?.loading(false);
  }

  if (actionData?.success && actionData?.pdfBase64) {
    if (typeof window !== "undefined") {
      alert("FILE PRONTO! Clicca OK per scaricare il PDF.");
      const linkSource = `data:application/pdf;base64,${actionData.pdfBase64}`;
      const downloadLink = document.createElement("a");
      downloadLink.href = linkSource;
      downloadLink.download = actionData.fileName || "stampai.pdf";
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      
      window.shopify?.loading(false);
      setSelectedItems([]);
      
      // Clear fetcher data to avoid loops
      fetcher.data.success = false;
      fetcher.data.pdfBase64 = null;
    }
  }

  const totalPodOrders = orders.length;
  const totalPodItems = orders.reduce((acc, order) => {
    return acc + order.lineItems.nodes.filter(item => {
      const metafields = item.product?.metafields?.nodes || [];
      return metafields.some(m => m.key === "svg" && (m.value || m.reference));
    }).length;
  }, 0);

  return (
    <Page title="Ordini Print on Demand">
      <Layout>
        <Layout.Section>
          <InlineStack gap="400" align="start">
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodOrders}</Text>
                <Text variant="bodySm" tone="subdued">Ordini POD in lista</Text>
              </div>
            </Card>
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodItems}</Text>
                <Text variant="bodySm" tone="subdued">Grafiche totali</Text>
              </div>
            </Card>
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="success">
                  {orders.filter(o => o.printed?.value === "true").length}
                </Text>
                <Text variant="bodySm" tone="subdued">Già stampati</Text>
              </div>
            </Card>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">Ordini da Elaborare</Text>
                <Button 
                  variant="primary" 
                  onClick={handleGenerate} 
                  disabled={selectedItems.length === 0}
                  loading={fetcher.state === "submitting"}
                >
                  Genera PDF per {selectedItems.length} ordini
                </Button>
              </InlineStack>

              {fetcher.data?.error && (
                <Badge tone="critical">{fetcher.data.error}</Badge>
              )}

              <ResourceList
                resourceName={{ singular: "ordine", plural: "ordini" }}
                items={orders}
                selectedItems={selectedItems}
                onSelectionChange={setSelectedItems}
                selectable
                renderItem={(order) => {
                  const { id, name, createdAt, totalPriceSet, printed, approved, tags } = order;
                  const date = new Date(createdAt).toLocaleDateString();
                  
                  const podItems = order.lineItems.nodes.filter(item => {
                    const metafields = item.product?.metafields?.nodes || [];
                    const hasSvg = metafields.some(m => m.namespace === "pod" && m.key === "svg" && (m.value || m.reference));
                    const hasUrl = metafields.some(m => m.namespace === "custom" && m.key === "pod_svg_url" && m.value);
                    return hasSvg || hasUrl;
                  });

                  const itemsReady = podItems.filter(item => {
                    const metafields = item.product?.metafields?.nodes || [];
                    const hasSvg = metafields.some(m => m.namespace === "pod" && m.key === "svg" && (m.value || m.reference));
                    const hasUrl = metafields.some(m => m.namespace === "custom" && m.key === "pod_svg_url" && m.value);
                    const hasWidth = metafields.some(m => m.namespace === "pod" && m.key === "width" && m.value);
                    const hasHeight = metafields.some(m => m.namespace === "pod" && m.key === "height" && m.value);
                    return (hasSvg || hasUrl) && hasWidth && hasHeight;
                  }).length;

                   const isPrinted = printed?.value === "true";
                   const isApproved = approved?.value === "approved";
                   const allTags = tags || [];
                   const isZepto = allTags.includes("product-personalizer");
                   const needsReview = isZepto && !isApproved;

                   return (
                    <div style={{ 
                      backgroundColor: needsReview ? "#fffcf5" : (isPrinted ? "#f1f8ed" : "transparent"), 
                      transition: "background-color 0.5s",
                      borderLeft: needsReview ? "5px solid #d82c0d" : "none"
                    }}>
                      <ResourceItem
                        id={id}
                        accessibilityLabel={`Dettagli per ordine ${name}`}
                      >
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text variant="bodyMd" fontWeight="bold">
                                {name}
                              </Text>
                              {isPrinted && <Badge tone="success">Stampato ✅</Badge>}
                              {needsReview && <Badge tone="critical">⚠️ DA REVISIONARE</Badge>}
                              {!needsReview && isZepto && <Badge tone="info">✅ Approvato</Badge>}
                            </InlineStack>
                            <Text variant="bodySm" tone="subdued">
                              {date} • {totalPriceSet.shopMoney.amount} {totalPriceSet.shopMoney.currencyCode}
                            </Text>
                            <InlineStack gap="200">
                              <Badge tone={itemsReady === podItems.length ? "success" : "warning"}>
                                {itemsReady} / {podItems.length} grafiche pronte
                              </Badge>
                              <Text variant="bodySm" tone="subdued">
                                ({order.lineItems.nodes.length} prodotti totali)
                              </Text>
                            </InlineStack>
                            
                            {/* Personalization Preview */}
                            <div style={{ marginTop: "8px", padding: "8px", backgroundColor: "#f9f9f9", borderRadius: "4px" }}>
                              <BlockStack gap="100">
                                <Text variant="bodyXs" fontWeight="bold" tone="subdued">DETTAGLI PERSONALIZZAZIONE (ZEPTO):</Text>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                                  {order.lineItems.nodes.flatMap(li => li.customAttributes || []).map((attr, idx) => (
                                    <div key={idx} style={{ fontSize: "11px", color: "#555" }}>
                                      <strong>{attr.key}</strong>: {attr.value.length > 50 ? attr.value.substring(0, 50) + '...' : attr.value}
                                    </div>
                                  ))}
                                  {order.lineItems.nodes.every(li => !li.customAttributes?.length) && (
                                    <Text variant="bodyXs" tone="subdueditalic">Nessuna personalizzazione trovata per questo ordine.</Text>
                                  )}
                                </div>
                              </BlockStack>
                            </div>
                          </BlockStack>
                          
                          <BlockStack gap="200" align="end">
                            {isZepto && (
                              <Button 
                                variant="primary"
                                tone={isApproved ? "success" : "critical"}
                                onClick={() => {
                                  const formData = new FormData();
                                  formData.append("type", "markAsApproved");
                                  formData.append("orderIds", JSON.stringify([id]));
                                  formData.append("value", isApproved ? "pending" : "approved");
                                  fetcher.submit(formData, { method: "POST" });
                                }}
                              >
                                {isApproved ? "✅ Approvato" : "Approva Grafica"}
                              </Button>
                            )}
                            <Button 
                              variant="plain" 
                              onClick={() => {
                                const formData = new FormData();
                                formData.append("type", "markAsPrinted");
                                formData.append("orderIds", JSON.stringify([id]));
                                formData.append("value", isPrinted ? "false" : "true");
                                fetcher.submit(formData, { method: "POST" });
                              }}
                            >
                              {isPrinted ? "Reset Stampa" : "Segna Stampato"}
                            </Button>
                          </BlockStack>
                        </InlineStack>
                      </ResourceItem>
                    </div>
                  );
                }}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
