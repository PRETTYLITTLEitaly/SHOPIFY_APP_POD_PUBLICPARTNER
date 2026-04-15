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
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    const response = await admin.graphql(
      `#graphql
      query getOrders {
        orders(first: 20, query: "status:open fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
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
            lineItems(first: 10) {
              nodes {
                id
                title
                quantity
                customAttributes { key value }
                product {
                  id
                  pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                  pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                  pod_svg: metafield(namespace: "pod", key: "svg") { 
                    namespace key value 
                    reference {
                      ... on GenericFile { url }
                      ... on MediaImage { image { url } }
                    }
                  }
                  custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                  custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                  custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
                }
                variant {
                  id
                  pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                  pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                  pod_svg: metafield(namespace: "pod", key: "svg") { 
                    namespace key value 
                    reference {
                      ... on GenericFile { url }
                      ... on MediaImage { image { url } }
                    }
                  }
                  custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                  custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                  custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
                }
              }
            }
          }
        }
      }
      `
    );

    const data = await response.json();
    const allOrders = data.data?.orders?.nodes || [];

    const podOrders = allOrders.filter(order => {
      const isZepto = order.tags?.includes("product-personalizer");
      const hasPodProduct = (order.lineItems?.nodes || []).some(item => {
        const metafields = [
          item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
          item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
          item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
          item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
        ].filter(Boolean);
        const hasSvgStr = metafields.some(m => m.key === "svg" && (m.value || m.reference));
        const hasUrlStr = metafields.some(m => m.key === "pod_svg_url" || m.key === "pod_url");
        return hasSvgStr || hasUrlStr;
      });
      return isZepto || hasPodProduct;
    });

    return json({ orders: podOrders });
  } catch (e) {
    console.error("Loader error:", e.message);
    return json({ orders: [], error: e.message });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const type = formData.get("type");

  if (type === "markAsApproved") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value");
    for (const id of orderIds) {
      await admin.graphql(
        `#graphql
        mutation updateOrderMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
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

  if (type === "markAsPrinted") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value");
    for (const id of orderIds) {
      await admin.graphql(
        `#graphql
        mutation markAsPrinted($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
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
    }
    return json({ success: true });
  }

  if (type === "generatePdf") {
    try {
      const selectedIds = JSON.parse(formData.get("orderIds"));
      const response = await admin.graphql(
        `#graphql
        query getBatchOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              tags
              status: metafield(namespace: "pod", key: "status") { value }
              lineItems(first: 10) {
                nodes {
                  id
                  title
                  quantity
                  customAttributes { key value }
                  product {
                    id
                    pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                    pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                    pod_svg: metafield(namespace: "pod", key: "svg") { 
                      namespace key value 
                      reference {
                        ... on GenericFile { url }
                        ... on MediaImage { image { url } }
                      }
                    }
                    custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                    custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                    custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
                  }
                  variant {
                    id
                    pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                    pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                    pod_svg: metafield(namespace: "pod", key: "svg") { 
                      namespace key value 
                      reference {
                        ... on GenericFile { url }
                        ... on MediaImage { image { url } }
                      }
                    }
                    custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                    custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                    custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
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
      const svgCache = new Map();

      const colorMap = {
        "Rosso": "#FF0000",
        "Nero": "#000000",
        "Bianco": "#FFFFFF",
        "Giallo": "#FFFF00",
        "Verde": "#008000",
        "Blu": "#0000FF",
        "Beige": "#F5F5DC"
      };

      for (const order of ordersDetails) {
        if (!order) continue;
        const isZeptoOrder = order.tags?.includes("product-personalizer");
        if (isZeptoOrder && order.status?.value !== "approved") {
          throw new Error(`Ordine ${order.name} non approvato.`);
        }

        for (const item of order.lineItems.nodes) {
          const metafields = [
            item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
            item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
            item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
            item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
          ].filter(Boolean);

          const widthVal = metafields.find(m => m.key === "width")?.value;
          const heightVal = metafields.find(m => m.key === "height")?.value;

          if (widthVal && heightVal) {
            const svgMeta = metafields.find(m => m.key === "svg");
            const svgTextUrl = metafields.find(m => m.key === "pod_svg_url" || m.key === "pod_url")?.value;
            let svgUrl = svgTextUrl || svgMeta?.reference?.url || svgMeta?.reference?.image?.url;
            let svgContent = null;

            const attrs = item.customAttributes || [];
            const zeptoText = attrs.find(a => a.key === "Scrivi il testo qui")?.value;

            if (!svgUrl && zeptoText) {
              const font = attrs.find(a => a.key === "Scegli Font")?.value || "Arial";
              const colorLabel = attrs.find(a => a.key === "Scegli Colore")?.value || "Nero";
              const sizeLine = attrs.find(a => a.key.includes("_font size"))?.value || "30";
              const alignLine = attrs.find(a => a.key.includes("_align"))?.value || "center";
              const color = colorMap[colorLabel] || colorLabel;

              svgContent = `
                <svg xmlns="http://www.w3.org/2000/svg" width="${widthVal}mm" height="${heightVal}mm" viewBox="0 0 ${widthVal * 10} ${heightVal * 10}">
                  <style>
                    @font-face {
                      font-family: '${font}';
                      src: url('/fonts/${font}.ttf');
                    }
                  </style>
                  <text x="${alignLine === 'center' ? '50%' : '10%'}" y="50%" 
                        text-anchor="${alignLine === 'center' ? 'middle' : 'start'}" 
                        dominant-baseline="middle" 
                        font-family="'${font}', Arial" 
                        font-size="${parseFloat(sizeLine) * 3}" 
                        fill="${color}">
                    ${zeptoText}
                  </text>
                </svg>`;
            }

            if (svgUrl && !svgContent) {
              if (svgUrl.startsWith("//")) svgUrl = "https:" + svgUrl;
              svgContent = svgCache.get(svgUrl);
              if (!svgContent) {
                try {
                  const svgRes = await fetch(svgUrl);
                  if (svgRes.ok) {
                    svgContent = await svgRes.text();
                    svgCache.set(svgUrl, svgContent);
                  }
                } catch (e) {
                  console.error("Fetch error:", e.message);
                }
              }
            }

            if (svgContent) {
              for (let i = 0; i < item.quantity; i++) {
                itemsToPack.push({
                  id: `${item.id}-${i}`,
                  orderName: order.name,
                  widthMm: parseFloat(widthVal),
                  heightMm: parseFloat(heightVal),
                  svgContent
                });
              }
            }
          }
        }
      }

      if (itemsToPack.length === 0) throw new Error("Nessuna grafica trovata.");

      for (const id of selectedIds) {
        await admin.graphql(
          `#graphql
          mutation updatePrinted($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
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

      const { generatePodPdf } = await import("../lib/pod.server");
      const pdfBuffer = await generatePodPdf(itemsToPack);

      return json({
        success: true,
        pdfBase64: pdfBuffer.toString("base64"),
        fileName: `STAMPA_POD_${new Date().getTime()}.pdf`
      });
    } catch (e) {
      return json({ error: e.message });
    }
  }
};

export default function OrdersComponent() {
  const { orders, error: loaderError } = useLoaderData();
  const fetcher = useFetcher();
  const actionData = fetcher.data;
  const [selectedItems, setSelectedItems] = useState([]);
  const [sortNewest, setSortNewest] = useState(true);

  useEffect(() => {
    if (actionData?.success && actionData?.pdfBase64) {
      const linkSource = `data:application/pdf;base64,${actionData.pdfBase64}`;
      const downloadLink = document.createElement("a");
      downloadLink.href = linkSource;
      downloadLink.download = actionData.fileName || "stampai.pdf";
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      window.shopify?.loading(false);
      setSelectedItems([]);
    }
    if (actionData?.error) {
      alert(`ERRORE: ${actionData.error}`);
      window.shopify?.loading(false);
    }
  }, [actionData]);

  const handleGenerate = async () => {
    window.shopify?.loading(true);
    const formData = new FormData();
    formData.append("type", "generatePdf");
    formData.append("orderIds", JSON.stringify(selectedItems));
    fetcher.submit(formData, { method: "POST" });
  };

  const totalPodOrders = (orders || []).length;
  const totalPodItems = (orders || []).reduce((acc, order) => {
    return acc + (order.lineItems?.nodes || []).filter(item => {
      const mf = [item.product?.pod_width, item.product?.pod_svg, item.product?.custom_url].filter(Boolean);
      return mf.length > 0;
    }).length;
  }, 0);

  const sortedOrders = [...(orders || [])].sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return sortNewest ? dateB - dateA : dateA - dateB;
  });

  return (
    <Page title="Dashboard Print on Demand">
      <Layout>
        {loaderError && (
          <Layout.Section>
            <Card>
              <Text variant="headingMd" as="h2" tone="critical">🚨 ERRORE CARICAMENTO: {loaderError}</Text>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack gap="400" align="start">
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodOrders}</Text>
                <Text variant="bodySm" tone="subdued">Ordini POD</Text>
              </div>
            </Card>
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodItems}</Text>
                <Text variant="bodySm" tone="subdued">Grafiche</Text>
              </div>
            </Card>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <BlockStack>
              <div style={{ padding: "16px", borderBottom: "1px solid #e1e3e5" }}>
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" align="center">
                    <Text variant="headingMd" as="h2">Ordini da Elaborare</Text>
                    <Button variant="plain" onClick={() => setSortNewest(!sortNewest)}>
                      {sortNewest ? "⇅ Recenti" : "⇅ Vecchi"}
                    </Button>
                  </InlineStack>
                  <Button
                    variant="primary"
                    onClick={handleGenerate}
                    disabled={selectedItems.length === 0}
                    loading={fetcher.state === "submitting"}
                  >
                    Genera PDF ({selectedItems.length})
                  </Button>
                </InlineStack>
              </div>

              <ResourceList
                resourceName={{ singular: 'ordine', plural: 'ordini' }}
                items={sortedOrders}
                selectedItems={selectedItems}
                onSelectionChange={setSelectedItems}
                selectable
                renderItem={(item) => {
                  const { id, name, createdAt, totalPriceSet, printed, approved, tags } = item;
                  const date = new Date(createdAt).toLocaleDateString('it-IT');
                  const isPrinted = printed?.value === "true";
                  const isApproved = approved?.value === "approved";
                  const isZepto = tags?.includes("product-personalizer");

                  const lineItemsNodes = item.lineItems?.nodes || [];
                  const podItems = lineItemsNodes.filter(li => {
                    const mf = [
                      li.product?.pod_width, li.product?.pod_svg, li.product?.custom_url,
                      li.variant?.pod_width, li.variant?.pod_svg, li.variant?.custom_url
                    ].filter(Boolean);
                    return mf.some(m => m.key === "svg" || m.key === "pod_svg_url" || m.key === "pod_url");
                  });

                  const itemsReady = podItems.filter(li => {
                    const mf = [
                      li.product?.pod_width, li.product?.pod_height, li.product?.pod_svg,
                      li.product?.custom_url, li.variant?.pod_width, li.variant?.pod_height,
                      li.variant?.pod_svg, li.variant?.custom_url
                    ].filter(Boolean);
                    const hasSvg = mf.some(m => m.key === "svg" || m.key === "pod_svg_url" || m.key === "pod_url");
                    const hasDim = mf.some(m => m.key === "width") && mf.some(m => m.key === "height");
                    return hasSvg && hasDim;
                  }).length;

                  return (
                    <ResourceItem id={id} accessibilityLabel={`Dettagli per ${name}`}>
                      <InlineStack align="space-between" blockAlign="center">
                        <div style={{ flex: 1 }}>
                          <BlockStack gap="050">
                            <InlineStack gap="200" align="center">
                              <Text variant="bodyMd" fontWeight="bold">{name}</Text>
                              {isPrinted && <Badge tone="success" size="small">Stampato</Badge>}
                              {isZepto && <Badge tone={isApproved ? "success" : "attention"} size="small">Zepto</Badge>}
                              <Text variant="bodySm" tone="subdued">{date} • {totalPriceSet.shopMoney.amount} {totalPriceSet.shopMoney.currencyCode}</Text>
                            </InlineStack>

                            <InlineStack gap="200" align="center">
                              <Badge tone={itemsReady === podItems.length && podItems.length > 0 ? "success" : "attention"} size="small">
                                {itemsReady} / {podItems.length} grafiche
                              </Badge>
                              <Text variant="bodyXs" tone="subdued">({lineItemsNodes.reduce((acc, li) => acc + li.quantity, 0)} prodotti)</Text>
                              {lineItemsNodes.map(li => {
                                const zText = li.customAttributes?.find(a => a.key === "Scrivi il testo qui")?.value;
                                return (
                                  <div key={li.id} style={{ display: 'inline-flex', marginLeft: '8px' }}>
                                    <Text variant="bodyXs" tone={zText ? "success" : "subdued"}>
                                      {zText ? `"${zText}"` : li.title} <strong>(x{li.quantity})</strong>
                                    </Text>
                                  </div>
                                );
                              })}
                            </InlineStack>
                          </BlockStack>
                        </div>

                        <InlineStack gap="100" align="end">
                          {isZepto && !isApproved && (
                            <Button size="slim" primary onClick={() => {
                              const formData = new FormData();
                              formData.append("type", "markAsApproved");
                              formData.append("orderIds", JSON.stringify([id]));
                              formData.append("value", "approved");
                              fetcher.submit(formData, { method: "POST" });
                            }}>Approva</Button>
                          )}
                          <Button size="slim" onClick={() => {
                            const formData = new FormData();
                            formData.append("type", "markAsPrinted");
                            formData.append("orderIds", JSON.stringify([id]));
                            formData.append("value", isPrinted ? "false" : "true");
                            fetcher.submit(formData, { method: "POST" });
                          }}>{isPrinted ? "Reset" : "Stampato"}</Button>
                        </InlineStack>
                      </InlineStack>
                    </ResourceItem>
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
