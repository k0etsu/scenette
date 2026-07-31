import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});
const FROM_ADDRESS = process.env.VERIFICATION_FROM_ADDRESS!;
const HTTP_API_URL = process.env.HTTP_API_URL!;

export async function sendVerificationEmail(email: string, username: string, token: string): Promise<void> {
  const verifyUrl = `${HTTP_API_URL}/auth/verify?token=${encodeURIComponent(token)}`;
  await ses.send(
    new SendEmailCommand({
      Source: FROM_ADDRESS,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Verify your scenette account" },
        Body: {
          Text: {
            Data: `Hi ${username},\n\nVerify your email to finish setting up your scenette account:\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create this account, you can ignore this email.`,
          },
        },
      },
    })
  );
}
