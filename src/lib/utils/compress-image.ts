/**
 * クライアントサイドの画像圧縮ユーティリティ
 * Canvas APIを使って画像をリサイズ・圧縮する
 */
export async function compressImage(
  file: File,
  maxWidth = 800,
  quality = 0.8
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img

      // maxWidth以下の場合はリサイズ不要
      if (width <= maxWidth) {
        // ただし JPEG 圧縮はかける
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new Error("Canvas コンテキストを取得できませんでした"))
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob)
            } else {
              reject(new Error("画像の圧縮に失敗しました"))
            }
          },
          "image/jpeg",
          quality
        )
        return
      }

      // アスペクト比を保ってリサイズ
      const ratio = maxWidth / width
      width = maxWidth
      height = Math.round(height * ratio)

      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext("2d")
      if (!ctx) {
        reject(new Error("Canvas コンテキストを取得できませんでした"))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error("画像の圧縮に失敗しました"))
          }
        },
        "image/jpeg",
        quality
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("画像の読み込みに失敗しました"))
    }

    img.src = url
  })
}
