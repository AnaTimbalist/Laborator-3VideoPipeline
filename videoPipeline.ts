import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Kafka, type EachMessagePayload } from "kafkajs";
import ffmpeg from "fluent-ffmpeg";

// ---------- Configuration ----------
const storageDir: string = path.join(__dirname, "storage");
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

const kafkaBrokers = ["localhost:9092"];
const outputFormats: string[] = ["mp4", "avi", "webm", "mkv"];

// ---------- "S3" Interface Implemented with the File System ----------
async function uploadToS3(localFilePath: string, s3Key: string): Promise<void> {
  const destPath = path.join(storageDir, s3Key);
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  await fs.promises.copyFile(localFilePath, destPath);
}

async function downloadFromS3(s3Key: string, localPath: string): Promise<string> {
  const srcPath = path.join(storageDir, s3Key);
  await fs.promises.copyFile(srcPath, localPath);
  return localPath;
}

async function downloadYouTubeVideo(videoUrl: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b" -o ${JSON.stringify(outputPath + ".mp4")} ${videoUrl}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${stderr}`);
        reject(error);
      } else {
        console.log(stdout);
        resolve(`${outputPath}.mp4`);
      }
    });
  });
}

async function produceEvent(s3Key: string): Promise<void> {
  const kafka = new Kafka({ clientId: "video-producer", brokers: kafkaBrokers });
  const producer = kafka.producer();

  try {
    await producer.connect();
    await producer.send({ topic: "video-uploads", messages: [{ value: JSON.stringify({ s3Key }) }] });
    console.log(`Produced event for S3 key: ${s3Key}`);
  } catch (err) {
    console.error("Error producing Kafka event:", err);
  } finally {
    await producer.disconnect();
  }
}

async function encodeVideo(inputPath: string, format: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const outputDir = path.join(__dirname, "temp_encoded");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const outputPath = path.join(outputDir, `${inputBasename}.${format}`);
    ffmpeg(inputPath)
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

async function runProducer(): Promise<void> {
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let ids = ["_HouxHKXNv0", "fs0AXusd2S0", "aP2up9N6H-g"];
  for (let id of ids) {
    try {
      const outputFilename = `downloaded_video_${id}`;
      let localOutputPath = path.join(tempDir, outputFilename);
      const videoUrl = `https://www.youtube.com/watch?v=${id}`;
      localOutputPath = await downloadYouTubeVideo(videoUrl, localOutputPath);
      const s3Key = `videos/${outputFilename}.mp4`;
      await uploadToS3(localOutputPath, s3Key);
      await produceEvent(s3Key);
      await fs.promises.unlink(localOutputPath);
    } catch (err) {
      console.error("Error in producer:", err);
    }
  }
}

async function processVideo(s3Key: string): Promise<void> {
  const tempDir = path.join(__dirname, "temp_encoded");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const localVideoPath = path.join(tempDir, path.basename(s3Key));

  try {
    await downloadFromS3(s3Key, localVideoPath);
    const encodedVideos = await Promise.all(outputFormats.map(format => encodeVideo(localVideoPath, format)));

    const encodedDir = path.join(storageDir, "encoded");
    if (!fs.existsSync(encodedDir)) fs.mkdirSync(encodedDir, { recursive: true });

    for (let i = 0; i < outputFormats.length; i++) {
      await uploadToS3(encodedVideos[i], `encoded/${path.basename(encodedVideos[i])}`);
      await fs.promises.unlink(encodedVideos[i]);
    }
    await fs.promises.unlink(localVideoPath);
  } catch (err) {
    console.error("Error processing video:", err);
  }
}

async function runConsumer(): Promise<void> {
  const kafka = new Kafka({ clientId: "video-consumer", brokers: kafkaBrokers });
  const consumer = kafka.consumer({ groupId: "video-group" });

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: "video-uploads", fromBeginning: true });

    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        const { s3Key } = JSON.parse(message.value?.toString() || "{}");
        if (s3Key) {
          console.log(`Received event for S3 key: ${s3Key}`);
          await processVideo(s3Key);
        } else {
          console.warn("Received invalid message:", message);
        }
      },
    });
  } catch (err) {
    console.error("Error in Kafka consumer:", err);
  }
}

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    console.error("Please specify mode: producer or consumer");
    process.exit(1);
  }
  if (mode === "producer") {
    await runProducer();
  } else if (mode === "consumer") {
    await runConsumer();
  } else {
    console.error('Unknown mode. Use "producer" or "consumer".');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
