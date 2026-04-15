import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (!admin) throw new Response();

  console.log(`--- WEBHOOK: ${topic} [${shop}] ---`);

  if (topic === "PRODUCTS_UPDATE") {
    const productId = `gid://shopify/Product/${payload.id}`;
    
    try {
      const response = await admin.graphql(
        `#graphql
        query getProductMetafields($id: ID!) {
          product(id: $id) {
            id
            metafields(first: 10, namespace: "pod") {
              nodes {
                id
                key
                value
                updatedAt
                reference {
                  ... on GenericFile { url }
                  ... on MediaImage { 
                    image { url width height } 
                  }
                }
              }
            }
          }
        }`,
        { variables: { id: productId } }
      );

      const data = await response.json();
      const metafields = data.data?.product?.metafields?.nodes || [];
      
      const svgMeta = metafields.find(m => m.key === "svg");
      const widthMeta = metafields.find(m => m.key === "width");
      const heightMeta = metafields.find(m => m.key === "height");
      
      const svgUrl = svgMeta?.reference?.url || svgMeta?.reference?.image?.url;
      const mediaImage = svgMeta?.reference?.image;
      const currentW = parseFloat(widthMeta?.value);
      const currentH = parseFloat(heightMeta?.value);

        if (svgUrl) {
          let ratio = 1;
          let intrinsicW = 0, intrinsicH = 0;

          if (mediaImage && mediaImage.width && mediaImage.height) {
            intrinsicW = mediaImage.width;
            intrinsicH = mediaImage.height;
            ratio = intrinsicW / intrinsicH;
          } else {
            const svgRes = await fetch(svgUrl);
            const svgText = await svgRes.text();
            const vb = svgText.match(/viewBox=["']\s*(-?\d*\.?\d+)[,\s]+(-?\d*\.?\d+)[,\s]+(\d*\.?\d+)[,\s]+(\d*\.?\d+)\s*["']/i);
            const wMatch = svgText.match(/width=["'](\d*\.?\d+)(px|mm|cm|in)?["']/i);
            const hMatch = svgText.match(/height=["'](\d*\.?\d+)(px|mm|cm|in)?["']/i);

            if (wMatch && hMatch) {
              intrinsicW = parseFloat(wMatch[1]);
              intrinsicH = parseFloat(hMatch[1]);
              if (wMatch[2] === "px") { intrinsicW *= 0.264583; intrinsicH *= 0.264583; }
              else if (wMatch[2] === "cm") { intrinsicW *= 10; intrinsicH *= 10; }
              else if (wMatch[2] === "in") { intrinsicW *= 25.4; intrinsicH *= 25.4; }
            } else if (vb) {
              intrinsicW = parseFloat(vb[3]);
              intrinsicH = parseFloat(vb[4]);
            }
            if (intrinsicH > 0) ratio = intrinsicW / intrinsicH;
          }

          let metafieldsToSet = [];
          
          if (!widthMeta && !heightMeta) {
            // Se entrambi mancano, suggeriamo le dimensioni intrinseche
            if (intrinsicW > 0 && intrinsicH > 0) {
              metafieldsToSet.push(
                { ownerId: productId, namespace: "pod", key: "width", value: intrinsicW.toFixed(1), type: "number_decimal" },
                { ownerId: productId, namespace: "pod", key: "height", value: intrinsicH.toFixed(1), type: "number_decimal" }
              );
            }
          } else if (widthMeta && heightMeta) {
            // Solo se ENTRAMBI esistono, eseguiamo la proporzionalità
            // Questo permette di cancellarne uno senza che venga ricreato automaticamente
            const timeW = new Date(widthMeta.updatedAt).getTime();
            const timeH = new Date(heightMeta.updatedAt).getTime();

            if (timeW >= timeH) {
              // Width è più recente o uguale, aggiorna Height
              const expectedH = (currentW / ratio).toFixed(1);
              if (Math.abs(currentH - parseFloat(expectedH)) > 0.1) {
                metafieldsToSet.push({ownerId: productId, namespace: "pod", key: "height", value: expectedH, type: "number_decimal"});
              }
            } else {
              // Height è più recente, aggiorna Width
              const expectedW = (currentH * ratio).toFixed(1);
              if (Math.abs(currentW - parseFloat(expectedW)) > 0.1) {
                metafieldsToSet.push({ownerId: productId, namespace: "pod", key: "width", value: expectedW, type: "number_decimal"});
              }
            }
          }

        if (metafieldsToSet.length > 0) {
          await admin.graphql(
            `#graphql
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message }
              }
            }`,
            { variables: { metafields: metafieldsToSet } }
          );
        }
      }
    } catch (err) {
      console.error("Webhook Error:", err.message);
    }
  }
  return new Response();
};
