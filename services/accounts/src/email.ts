import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});
const FROM_ADDRESS = process.env.VERIFICATION_FROM_ADDRESS!;

// verifyUrlBase is the origin the account API is reachable at (derived from
// the incoming request, so it works on both the execute-api domain and the
// custom api.<zone> domain without a config value to keep in sync).
export async function sendVerificationEmail(
  email: string,
  username: string,
  token: string,
  verifyUrlBase: string
): Promise<void> {
  const verifyUrl = `${verifyUrlBase}/auth/verify?token=${encodeURIComponent(token)}`;
  await ses.send(
    new SendEmailCommand({
      Source: FROM_ADDRESS,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Verify your scenette email" },
        Body: {
          Text: {
            Data:
              `Hi ${username},\n\n` +
              `Verify this email address to create and use your own scenette room:\n` +
              `${verifyUrl}\n\n` +
              `This link expires in 24 hours. If you didn't request it, you can ignore this email.\n`,
          },
        },
      },
    })
  );
}
