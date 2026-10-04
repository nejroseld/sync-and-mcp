import jsQR from "jsqr";
import QRCode from "qrcode";

/** The QR contains the compact form of exactly the same device-adder JSON. */
export const deviceAdderQrUrl = (text: string): Promise<string> =>
  QRCode.toDataURL(JSON.stringify(JSON.parse(text)), {
    errorCorrectionLevel: "L",
    margin: 3,
    width: 420,
  });

export const readDeviceAdderQr = async (file: File): Promise<string> => {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
  const objectUrl = URL.createObjectURL(file);
  try {
    const photo = new Image();
    await new Promise<void>((resolve, reject) => {
      photo.onload = () => resolve();
      photo.onerror = () => reject(new Error("Cannot open the image"));
      photo.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(photo.naturalWidth, photo.naturalHeight));
    canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Cannot read the image");
    context.drawImage(photo, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
    if (!decoded) throw new Error("No readable QR code found in the image");
    return decoded.data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};
